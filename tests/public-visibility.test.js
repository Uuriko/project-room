// One visibility predicate for public receipts (ATLAS-PUBLIC R-1).
//
// The consent rule for a stored public receipt has exactly one definition
// (server/public-visibility.mjs): not operator-unpublished (receipt or
// room), and not in a room whose owner turned public receipts off. Every
// public read applies the whole rule in SQL, before pagination — no
// surface post-filters a page it already paginated, because a post-filter
// both shortens pages and brackets the positions of the rows it dropped.
//
// These tests pin the surfaces, not the module: the read model's own
// functions answer with the full rule (the Stage 0 offload consumes the
// read model directly), and the receipts-live wrapper is a pass-through.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  collectPublicReceipts,
  listPublicReceiptSitemap,
  publicReceiptById,
  roomProofRows,
} from "../server/public-read-model.mjs";
import {
  queryPublicReceipts,
  listPublicReceiptSitemap as liveSitemap,
  excludeHiddenReceipts,
} from "../server/receipts-live.mjs";

const hex = (ch, n = 32) => ch.repeat(n);
const wcr = ch => `wcr_${hex(ch)}`;

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-visibility-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedReceipt(store, { id, room, origin = room, source = "work-claim", at }) {
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, `Receipt ${id.slice(4, 8)}`, source, origin, room, null, "[]", "[]",
      null, null, null, "[]", at, "https://room.trydemigod.com/?start=room");
}

function toggleOff(store, room) {
  store.db.prepare(`INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts)
    VALUES (?, 0, NULL, 0, 0) ON CONFLICT(room_id) DO UPDATE SET public_receipts=0`).run(room);
}

function unpublish(store, kind, target) {
  store.db.prepare("INSERT INTO public_unpublish (kind, target, at, by_account) VALUES (?, ?, 0, 'op')").run(kind, target);
}

test("the read model itself excludes owner-hidden and unpublished receipts on every surface", t => {
  const store = serve(t);
  seedReceipt(store, { id: wcr("a"), room: "room-open", at: "2026-10-05T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("b"), room: "room-toggled", at: "2026-10-04T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("c"), room: "room-open", at: "2026-10-03T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("d"), room: "room-taken", at: "2026-10-02T00:00:00.000Z" });
  toggleOff(store, "room-toggled");
  unpublish(store, "receipt", wcr("c"));
  unpublish(store, "room", "room-taken");

  assert.deepEqual(collectPublicReceipts(store).map(r => r.id), [wcr("a")], "collect applies the full predicate");
  assert.deepEqual(listPublicReceiptSitemap(store, 10).map(e => e.path), [`/receipts/${wcr("a")}`], "sitemap applies the full predicate");
  assert.equal(publicReceiptById(store, wcr("b")), null, "detail read hides an owner-toggled receipt");
  assert.equal(publicReceiptById(store, wcr("c")), null, "detail read hides an unpublished receipt");
  assert.ok(publicReceiptById(store, wcr("a")), "the visible receipt still resolves");
  assert.deepEqual(roomProofRows(store, "room-toggled").map(r => r.id), [], "proof rows apply the full predicate");
  assert.deepEqual(roomProofRows(store, "room-open").map(r => r.id), [wcr("a")], "proof rows keep the visible receipt");
});

test("hidden rows never consume the sitemap clamp budget", t => {
  const store = serve(t);
  // Three owner-hidden receipts are the newest; three visible ones follow.
  seedReceipt(store, { id: wcr("e"), room: "room-toggled", at: "2026-10-09T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("f"), room: "room-toggled", at: "2026-10-08T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("1"), room: "room-toggled", at: "2026-10-07T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("2"), room: "room-open", at: "2026-10-06T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("3"), room: "room-open", at: "2026-10-05T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("4"), room: "room-open", at: "2026-10-04T00:00:00.000Z" });
  toggleOff(store, "room-toggled");

  const entries = liveSitemap(store, 3);
  assert.deepEqual(entries.map(e => e.path),
    [`/receipts/${wcr("2")}`, `/receipts/${wcr("3")}`, `/receipts/${wcr("4")}`],
    "the clamp counts visible receipts only — hidden rows are filtered before the LIMIT");
});

test("list pages stay full across interleaved hidden rows (wrapper contract)", t => {
  const store = serve(t);
  seedReceipt(store, { id: wcr("5"), room: "room-toggled", at: "2026-10-09T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("6"), room: "room-open", at: "2026-10-08T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("7"), room: "room-open", at: "2026-10-07T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("8"), room: "room-open", at: "2026-10-06T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("9"), room: "room-open", at: "2026-10-05T00:00:00.000Z" });
  toggleOff(store, "room-toggled");
  unpublish(store, "receipt", wcr("7"));

  const page = queryPublicReceipts(store, { limit: 3 });
  assert.deepEqual(page.receipts.map(r => r.id), [wcr("6"), wcr("8"), wcr("9")]);
  assert.equal(page.nextCursor, null);
});

test("excludeHiddenReceipts applies the whole rule, not only the owner toggle", t => {
  const store = serve(t);
  seedReceipt(store, { id: wcr("a"), room: "room-open", at: "2026-10-05T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("c"), room: "room-open", at: "2026-10-03T00:00:00.000Z" });
  unpublish(store, "receipt", wcr("c"));

  const kept = excludeHiddenReceipts(store, [{ id: wcr("a") }, { id: wcr("c") }, { id: wcr("0") }]);
  assert.deepEqual(kept.map(item => item.id), [wcr("a")],
    "unpublished rows drop, visible rows stay, unknown ids fail closed");
});
