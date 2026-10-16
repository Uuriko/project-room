// #3595: a feed cursor naming an operator-unpublished receipt must be
// refused with the same 422 as a never-existent id. Before the fix, the
// cursor lookup in queryPublicReceipts skipped the HIDDEN_RECEIPT filter
// the page query applies, so a hidden receipt still anchored a page —
// confirming it exists and where it sits in the order.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { queryPublicReceipts as queryLive } from "../server/receipts-live.mjs";
import { queryPublicReceipts as queryModel } from "../server/public-read-model.mjs";

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
