// Compound-cursor adapter for the inbox source-list walk (#3677 §B.4
// adopter 2). Everything goes through the real surface: Inbox.list() in
// server/inbox.mjs, with its real encodeCursor/decodeCursor (inbox.mjs:67/77)
// and the real page walk (inbox.mjs:556), over an acceptance-fixture store.
//
// Fixture-level direct row writes are used ONLY to place sort keys
// deterministically (private_inbox_sources.updated_at) and to simulate an
// external delete (there is no source-delete command); every read, page,
// cursor and limit behaviour under test is the production code path.
// updated_at values are pinned to a synthetic clock (BASE - k*STEP) far
// below wall-clock time, so a real re-save (move) always bumps an item to
// the front of the walk — the production update-that-moves-item semantics.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../scripts/acceptance-fixture.mjs";

const BASE = 1_000_000_000;
const STEP = 1_000;
const DATA = {
  adapter: "synthetic",
  sender: "maya@example.test",
  recipient: "you@example.test",
  subject: "Subject",
  paragraphs: ["Body."],
};

export function createInboxAdapter() {
  const f = createAcceptanceFixture();
  f.filename = join(f.directory, "room.sqlite");
  const account = f.store.accountForMember("commons", "owner");
  const key = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot();
  const session = { token: slot.token, ...f.store.loginAccountSession(slot.token, key, 0) };
  const inbox = f.store.inbox;
  const db = inbox.db;

  const list = (opts) => inbox.list(session.token, session.sessionBinding, opts);
  const rowOf = (id) => db.prepare(
    "SELECT id, revision, updated_at FROM private_inbox_sources WHERE account_id=? AND id=?",
  ).get(account.id, id);
  const setUpdatedAt = (id, value) => db.prepare(
    "UPDATE private_inbox_sources SET updated_at=? WHERE account_id=? AND id=?",
  ).run(value, account.id, id);
  const addSource = (id) => inbox.apply(session.token, {
    action: "source.save", requestId: randomUUID(), sourceId: id, expectedRevision: 0,
    data: { ...DATA, subject: `Subject ${id}` },
  }, session.sessionBinding);
  const extremes = () => db.prepare(
    "SELECT MIN(updated_at) AS lo, MAX(updated_at) AS hi FROM private_inbox_sources WHERE account_id=?",
  ).get(account.id);

  let cursor = null; // decoded { updatedAt, id } of the last page, or null
  let cursorRaw = null; // the opaque token exactly as list() returned it
  let finished = false;

  return {
    name: "inbox",
    supportedOps: [
      "walkNext", "insertBeforeCursor", "insertAfterCursor", "moveItem",
      // deleteUnvisited/deleteVisited unsupported, declared not dropped:
      // inbox sources cannot be deleted at all — there is no source-delete
      // command, and the store retains versions immutably (trigger
      // private_inbox_versions_no_delete, inbox.mjs:149), so the source
      // row is FK-pinned by its own versions.
      // visibilityFlip unsupported: synthetic sources have no list-level
      // visibility switch the walk honours (quarantine is a separate
      // journal).
    ],
    capBehaviour: "limit outside 1..100 fails 422 invalid_limit (pageLimitOf, inbox.mjs:61)",
    fixture: f,
    account,
    session,
    list,
    rowOf,
    setUpdatedAt,
    addSource,

    seed(n) {
      const ids = [];
      for (let i = 1; i <= n; i++) {
        const id = `s-${String(i).padStart(3, "0")}`;
        addSource(id);
        setUpdatedAt(id, BASE - i * STEP); // s-001 newest, descending
        ids.push(id);
      }
      return ids;
    },
    openWalk() { cursor = null; cursorRaw = null; finished = false; },
    nextPage(limit) {
      const page = list({ limit, cursor: cursorRaw });
      const items = page.sources.map((s) => s.id);
      if (page.nextCursor) {
        cursorRaw = page.nextCursor;
        cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"));
      } else {
        finished = true;
      }
      return { items, nextCursor: page.nextCursor };
    },
    insertBeforeCursor(id) {
      // Newest position: front of the DESC walk = the visited region.
      addSource(id);
      setUpdatedAt(id, extremes().hi + STEP);
      return id;
    },
    insertAfterCursor(id) {
      // Oldest position: end of the DESC walk = the unvisited region.
      addSource(id);
      setUpdatedAt(id, extremes().lo - STEP);
      return id;
    },
    remove() {
      // Unreachable: delete ops are not in supportedOps (see above —
      // inbox sources are retained, never deleted).
      throw new Error("inbox adapter does not support remove: sources are retained");
    },
    move(id) {
      // The real update path: re-saving bumps updated_at to wall-clock
      // now, far above the synthetic clock — the item jumps to the front.
      const row = rowOf(id);
      if (!row) return;
      inbox.apply(session.token, {
        action: "source.save", requestId: randomUUID(), sourceId: id,
        expectedRevision: row.revision, data: { ...DATA, subject: `Moved ${id}` },
      }, session.sessionBinding);
    },
    inUnvisitedRegion(id) {
      if (finished) return false;
      const row = rowOf(id);
      if (!row) return false;
      if (!cursor) return true;
      return row.updated_at < cursor.updatedAt
        || (row.updated_at === cursor.updatedAt && id > cursor.id);
    },
    present(id) { return Boolean(rowOf(id)); },
    visible(id) { return Boolean(rowOf(id)); },
    close() {
      try { f.store.close(); } catch { /* already closed */ }
      rmSync(f.directory, { recursive: true, force: true });
    },

    // A second, independent scope (account) over the same store, for P3.
    openSecondScope() {
      const guest = f.store.accountForMember("commons", "guest");
      const guestKey = f.store.issueAccountAccessKey(guest.id);
      const guestSlot = f.store.createAccountSessionSlot();
      const guestSession = { token: guestSlot.token, ...f.store.loginAccountSession(guestSlot.token, guestKey, 0) };
      return {
        account: guest,
        list: (opts) => inbox.list(guestSession.token, guestSession.sessionBinding, opts),
        addSource: (id) => inbox.apply(guestSession.token, {
          action: "source.save", requestId: randomUUID(), sourceId: id, expectedRevision: 0,
          data: { ...DATA, subject: `Guest ${id}` },
        }, guestSession.sessionBinding),
        setUpdatedAt: (id, value) => db.prepare(
          "UPDATE private_inbox_sources SET updated_at=? WHERE account_id=? AND id=?",
        ).run(value, guest.id, id),
      };
    },
  };
}
