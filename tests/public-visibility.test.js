// One visibility predicate for public receipts (ATLAS-PUBLIC R-1).
//
// The consent rule for a stored public receipt has exactly one definition
// (server/public-visibility.mjs): not operator-unpublished (receipt or
// room), not in a room whose owner turned public receipts off, and — for
// a room-source row — the origin room's recorded opt-in still on
// (Ruling 40). Every
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
  queryPublicReceipts as modelQueryPublicReceipts,
  roomPageReceipts,
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

function recordOptIn(store, room) {
  // A room-source row is the projection of a recorded opt-in (Ruling
  // 40): a fixture seeding such a row for a room that is meant to be
  // visible records the opt-in the projection would have mirrored.
  store.db.prepare("INSERT INTO room_public_receipts_setting (room_id, enabled) VALUES (?, 1)").run(room);
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
  recordOptIn(store, "room-open");
  recordOptIn(store, "room-toggled");
  recordOptIn(store, "room-taken");
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
  recordOptIn(store, "room-open");
  recordOptIn(store, "room-toggled");
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
  recordOptIn(store, "room-open");
  recordOptIn(store, "room-toggled");
  toggleOff(store, "room-toggled");
  unpublish(store, "receipt", wcr("7"));

  const page = queryPublicReceipts(store, { limit: 3 });
  assert.deepEqual(page.receipts.map(r => r.id), [wcr("6"), wcr("8"), wcr("9")]);
  assert.equal(page.nextCursor, null);
});

test("drift specimen (Ruling 40): a stale row outliving a recorded opt-out is refused on every anonymous surface", t => {
  const store = serve(t);
  const room = "commons";
  const ownerKey = store.issueAccessKey(room, "owner");
  const setReceipts = (id, enabled) =>
    store.command(ownerKey, room, { id, type: "room.public_receipts_set", data: { enabled } });
  // Listed, so the projected row carries room_id and the ?room= list
  // leg is exercised (an unlisted room's rows carry room_id=null).
  store.db.prepare(`INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at, public_receipts)
    VALUES (?, 1, NULL, 0, 1)`).run(room);
  store.workClaims.set(room, {
    id: "drift-claim", title: "Drift claim", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: [], updatedAt: "2026-10-01T00:00:00.000Z",
  });
  setReceipts("opt-in", true);

  // The sync projected the row and mirrored the recorded opt-in.
  const projected = store.db.prepare("SELECT * FROM public_receipts WHERE origin_room_id=?").get(room);
  assert.ok(projected, "the opted-in room's claim projected a row");
  const setting = store.db.prepare("SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(room);
  assert.equal(setting?.enabled, 1, "the recorded opt-in is mirrored");
  const id = projected.id;

  const anonymousSurfaces = () => ({
    list: modelQueryPublicReceipts(store, {}).receipts.map(r => r.id),
    roomList: modelQueryPublicReceipts(store, { room }).receipts.map(r => r.id),
    detail: publicReceiptById(store, id),
    collect: collectPublicReceipts(store).map(r => r.id),
    sitemap: listPublicReceiptSitemap(store, 10).map(e => e.path),
    proof: roomProofRows(store, room).map(r => r.id),
    roomPage: roomPageReceipts(store, room, true).map(r => r.id),
    postFilter: excludeHiddenReceipts(store, [{ id }]).map(item => item.id),
  });
  const servesEverywhere = () => {
    const s = anonymousSurfaces();
    assert.ok(s.list.includes(id), "list serves");
    assert.ok(s.roomList.includes(id), "?room= list serves");
    assert.ok(s.detail, "detail serves");
    assert.ok(s.collect.includes(id), "collect serves");
    assert.ok(s.sitemap.includes(`/receipts/${id}`), "sitemap serves");
    assert.ok(s.proof.includes(id), "proof rows serve");
    assert.ok(s.roomPage.includes(id), "room page serves");
    assert.deepEqual(s.postFilter, [id], "post-filter keeps");
  };
  const refusesEverywhere = label => {
    const s = anonymousSurfaces();
    assert.ok(!s.list.includes(id), `${label}: list omits`);
    assert.ok(!s.roomList.includes(id), `${label}: ?room= list omits`);
    assert.equal(s.detail, null, `${label}: detail refuses`);
    assert.ok(!s.collect.includes(id), `${label}: collect omits`);
    assert.ok(!s.sitemap.includes(`/receipts/${id}`), `${label}: sitemap omits`);
    assert.ok(!s.proof.includes(id), `${label}: proof rows omit`);
    assert.ok(!s.roomPage.includes(id), `${label}: room page omits`);
    assert.deepEqual(s.postFilter, [], `${label}: post-filter drops`);
  };

  servesEverywhere();

  // Clean opt-out: the sync deletes the row and records the off. Every
  // surface refuses — the control the drift leg must preserve.
  setReceipts("opt-out", false);
  assert.equal(store.db.prepare("SELECT enabled FROM room_public_receipts_setting WHERE room_id=?").get(room)?.enabled, 0,
    "the opt-out is recorded");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM public_receipts WHERE id=?").get(id).n, 0,
    "the sync deleted the row");
  refusesEverywhere("clean opt-out");

  // Drift: the stale row reappears (the write-side invariant has already
  // failed — the settled-lot shape). The recorded opt-out must still
  // refuse it at read time, on every surface.
  const columns = Object.keys(projected);
  store.db.prepare(`INSERT INTO public_receipts (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map(c => projected[c]));
  refusesEverywhere("stale row, recorded off");

  // Drift, second shape: the mirror row itself is gone — never-recorded
  // is private for a room-source row, exactly as for a lot.
  store.db.prepare("DELETE FROM room_public_receipts_setting WHERE room_id=?").run(room);
  refusesEverywhere("stale row, setting unrecorded");
});

test("excludeHiddenReceipts applies the whole rule, not only the owner toggle", t => {
  const store = serve(t);
  seedReceipt(store, { id: wcr("a"), room: "room-open", at: "2026-10-05T00:00:00.000Z" });
  seedReceipt(store, { id: wcr("c"), room: "room-open", at: "2026-10-03T00:00:00.000Z" });
  recordOptIn(store, "room-open");
  unpublish(store, "receipt", wcr("c"));

  const kept = excludeHiddenReceipts(store, [{ id: wcr("a") }, { id: wcr("c") }, { id: wcr("0") }]);
  assert.deepEqual(kept.map(item => item.id), [wcr("a")],
    "unpublished rows drop, visible rows stay, unknown ids fail closed");
});
