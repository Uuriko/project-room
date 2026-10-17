// #3595: a feed cursor naming a hidden receipt must be refused with the
// same 422 as a never-existent id. Before the fix, the cursor lookup in
// queryPublicReceipts skipped the hidden filters the page query applies,
// so a hidden receipt still anchored a page — confirming it exists and
// where it sits in the order. Both hiding mechanisms count: operator
// unpublish (HIDDEN_RECEIPT) and the owner public-receipts toggle
// (room_directory_settings.public_receipts = 0).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { queryPublicReceipts as queryLive } from "../server/receipts-live.mjs";
import { queryPublicReceipts as queryModel, projectPublicWorkReceipt } from "../server/public-read-model.mjs";

function serve(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cursor-hidden-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const key = store.issueAccessKey("alpha", "owner");
  store.command(key, "alpha", { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  const claim = (id, title, at) => ({
    id, title, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", outcome: "merged", syncedAt: at },
    blobs: [], updatedAt: at,
  });
  store.workClaims.set("alpha", claim("older", "Older win", "2026-10-01T00:00:00.000Z"));
  store.workClaims.set("alpha", claim("newer", "Newer win", "2026-10-02T00:00:00.000Z"));
  store.workClaims.set("alpha", claim("newest", "Newest win", "2026-10-03T00:00:00.000Z"));
  const rows = store.db.prepare("SELECT id, title FROM public_receipts ORDER BY at ASC").all();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rows };
}

test("a visible receipt still anchors a page (control)", t => {
  const { store, rows } = serve(t);
  const page = queryLive(store, { cursor: rows[2].id, limit: 10 });
  assert.equal(page.error, undefined);
  assert.deepEqual(page.receipts.map(r => r.title), ["Newer win", "Older win"]);
});

test("an operator-unpublished receipt is refused as a cursor, like a ghost id", t => {
  const { store, rows } = serve(t);
  const hidden = rows[1];
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('receipt', ?, ?, 'op')")
    .run(hidden.id, "2026-10-04T00:00:00.000Z");
  for (const query of [queryModel, queryLive]) {
    const viaHidden = query(store, { cursor: hidden.id, limit: 10 });
    assert.equal(viaHidden.error?.status, 422);
    assert.equal(viaHidden.error?.code, "invalid_receipt_query");
    const viaGhost = query(store, { cursor: `wcr_${"0".repeat(32)}`, limit: 10 });
    assert.deepEqual(viaHidden, viaGhost, "hidden and never-existent cursors answer identically");
  }
  // The visible neighbours still paginate around the gap.
  const page = queryLive(store, { cursor: rows[2].id, limit: 10 });
  assert.deepEqual(page.receipts.map(r => r.title), ["Older win"]);
});

test("a room-level unpublish also invalidates its receipts as cursors", t => {
  const { store, rows } = serve(t);
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES ('room', 'alpha', ?, 'op')")
    .run("2026-10-04T00:00:00.000Z");
  const page = queryLive(store, { cursor: rows[0].id, limit: 10 });
  assert.equal(page.error?.status, 422);
});

const GHOST = `wcr_${"0".repeat(32)}`;

const toggleOff = (store, roomId) => store.db.prepare(`INSERT INTO room_directory_settings
  (room_id, discoverable, listed_at, updated_at, opportunities_enabled, public_receipts)
  VALUES (?, 0, NULL, 1, 1, 0)`).run(roomId);

test("an owner-hidden receipt is refused as a cursor, like a ghost id", t => {
  const { store, rows } = serve(t);
  toggleOff(store, "alpha");
  for (const query of [queryModel, queryLive]) {
    const viaHidden = query(store, { cursor: rows[1].id, limit: 10 });
    assert.equal(viaHidden.error?.status, 422);
    assert.equal(viaHidden.error?.code, "invalid_receipt_query");
    const viaGhost = query(store, { cursor: GHOST, limit: 10 });
    assert.deepEqual(viaHidden, viaGhost, "owner-hidden and never-existent cursors answer identically");
  }
  // The feed itself serves nothing while the room's toggle is off.
  assert.deepEqual(queryLive(store, { limit: 10 }).receipts, []);
});

function serveTwoRooms(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cursor-owner-hidden-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const claim = (id, title, at) => ({
    id, title, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", outcome: "merged", syncedAt: at },
    blobs: [], updatedAt: at,
  });
  for (const roomId of ["alpha", "beta"]) {
    store.initialize(initialRoom(roomId));
    const key = store.issueAccessKey(roomId, "owner");
    store.command(key, roomId, { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  }
  store.workClaims.set("beta", claim("b-old", "Beta oldest", "2026-10-01T00:00:00.000Z"));
  store.workClaims.set("alpha", claim("a-mid", "Alpha mid", "2026-10-02T00:00:00.000Z"));
  store.workClaims.set("beta", claim("b-new", "Beta newer", "2026-10-03T00:00:00.000Z"));
  store.workClaims.set("alpha", claim("a-new", "Alpha newest", "2026-10-04T00:00:00.000Z"));
  const rows = store.db.prepare("SELECT id, title FROM public_receipts ORDER BY at ASC").all();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rows };
}

test("mixed feed: an owner-hidden room's receipts are refused as cursors and never handed out as nextCursor", t => {
  const { store, rows } = serveTwoRooms(t);
  const byTitle = Object.fromEntries(rows.map(r => [r.title, r.id]));
  toggleOff(store, "beta");
  for (const query of [queryModel, queryLive]) {
    for (const title of ["Beta oldest", "Beta newer"]) {
      const viaHidden = query(store, { cursor: byTitle[title], limit: 10 });
      assert.equal(viaHidden.error?.status, 422, title);
      assert.deepEqual(viaHidden, query(store, { cursor: GHOST, limit: 10 }), title);
    }
  }
  // The visible room's receipts still paginate end to end: every served
  // nextCursor anchors the next page, and the walk sees exactly the
  // visible receipts in order (page contents unchanged).
  const seen = [];
  let cursor = null;
  for (let hops = 0; hops < 5; hops += 1) {
    const page = queryLive(store, { cursor, limit: 1 });
    assert.equal(page.error, undefined);
    seen.push(...page.receipts.map(r => r.title));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, ["Alpha newest", "Alpha mid"]);
  // A visible cursor still anchors, with the same page as before the fix.
  const anchored = queryLive(store, { cursor: byTitle["Alpha newest"], limit: 10 });
  assert.equal(anchored.error, undefined);
  assert.deepEqual(anchored.receipts.map(r => r.title), ["Alpha mid"]);
});

test("a public-work receipt is refused as a cursor while its task room's toggle is off", t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cursor-owner-hidden-pwr-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("task-room"));
  const PWR = `pwr_${"ab".repeat(32)}`;
  const NAMESPACE = `public_${"ef".repeat(16)}`;
  const now = Date.now();
  store.db.prepare(`INSERT INTO public_work_tasks
      (offer_id, namespace_key, room_id, terms_version, repository_url, repository_ref, files_json, generation, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("offer-1", NAMESPACE, "task-room", 1, "https://github.com/Uuriko/project-room", "main", "[]", 1, now);
  const body = { schema: "public-work-receipt/1", receiptId: PWR, namespaceId: NAMESPACE, identityId: "ai_public",
    title: "Public task", createdAt: "2026-10-01T00:00:00.000Z", artifact: { sha256: "ab".repeat(32) } };
  store.db.prepare("INSERT INTO public_work_receipts VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    PWR, "offer-1", NAMESPACE, 1, "ai_public", "note", "ab".repeat(32), 4, JSON.stringify(body), now);
  projectPublicWorkReceipt(store, body, "ab".repeat(32));
  // Control: while the room is public the receipt anchors a page. Its
  // origin is a namespace, so only the task-record room resolution can
  // hide it — the branch this test pins.
  assert.equal(queryLive(store, { cursor: PWR, limit: 10 }).error, undefined);
  toggleOff(store, "task-room");
  for (const query of [queryModel, queryLive]) {
    const viaHidden = query(store, { cursor: PWR, limit: 10 });
    assert.equal(viaHidden.error?.status, 422);
    assert.deepEqual(viaHidden, query(store, { cursor: GHOST, limit: 10 }));
  }
  // Flipping the toggle back on restores the anchor immediately.
  store.db.prepare("UPDATE room_directory_settings SET public_receipts = 1 WHERE room_id = 'task-room'").run();
  assert.equal(queryLive(store, { cursor: PWR, limit: 10 }).error, undefined);
});
