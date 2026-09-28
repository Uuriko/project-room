// Emissary slice 1a — external receipt index tests (RC-2026-09-27-2860).
//
// Contracts guarded (test-audit gate):
//  1. record mints a well-formed ert1 id and round-trips the payload.
//  2. record fails closed on unknown rooms, bad kinds, unknown externals,
//     and oversized payloads (nothing written on failure).
//  3. get round-trips; unknown/malformed ids fail closed.
//  4. listByExternal is deterministic, kind-filterable, paginated, and
//     fails closed on unknown externals.
//  5. listByOffer returns exactly the receipts for that offer.
//  6. reassignExternal moves every receipt between identities.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RECEIPT_ID_RE } from "../server/emissary-receipts.mjs";

const ROOM = "commons";

function freshStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-emissary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom(ROOM));
  return store;
}

const serviceError = (fn) => {
  try { fn(); } catch (error) { return { status: error.status, code: error.code }; }
  return null;
};

function external(t, store) {
  return store.emissaryGraph.register(ROOM, { kind: "agent", displayName: "Worker" }).external_id;
}

test("record mints an ert1 id and round-trips the payload", t => {
  const store = freshStore(t);
  const ext = external(t, store);
  const receipt = store.emissaryReceipts.record(ROOM, {
    externalId: ext, offerId: "offer-7", kind: "work",
    payload: { summary: "did the thing", sig: "deadbeef" },
  });
  assert.match(receipt.receipt_id, RECEIPT_ID_RE);
  assert.equal(receipt.external_id, ext);
  assert.equal(receipt.offer_id, "offer-7");
  assert.equal(receipt.kind, "work");
  assert.deepEqual(receipt.payload, { summary: "did the thing", sig: "deadbeef" });
  assert.ok(typeof receipt.created_at === "number");
  // Optional links may be omitted.
  const bare = store.emissaryReceipts.record(ROOM, { kind: "oracle" });
  assert.equal(bare.external_id, null);
  assert.equal(bare.offer_id, null);
  assert.deepEqual(bare.payload, {});
});

test("record fails closed and writes nothing", t => {
  const store = freshStore(t);
  const ext = external(t, store);
  const count = () => store.db.prepare("SELECT COUNT(*) c FROM external_receipts").get().c;
  const before = count();
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record("nope", { kind: "work" })),
    { status: 404, code: "unknown_room" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record(ROOM, { kind: "lottery" })),
    { status: 422, code: "invalid_emissary_input" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record(ROOM, { kind: "work", externalId: "bogus" })),
    { status: 422, code: "invalid_emissary_input" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record(ROOM, { kind: "work", externalId: "ex1." + "c".repeat(32) })),
    { status: 404, code: "unknown_external" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record(ROOM, { kind: "work", payload: "nope" })),
    { status: 422, code: "invalid_emissary_input" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record(ROOM, { kind: "work", payload: { big: "x".repeat(70000) } })),
    { status: 422, code: "invalid_emissary_input" });
  // An external id from a different room is unknown here.
  store.initialize(initialRoom("lab"));
  const labExt = store.emissaryGraph.register("lab", { kind: "agent", displayName: "Lab" }).external_id;
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.record(ROOM, { kind: "work", externalId: labExt })),
    { status: 404, code: "unknown_external" });
  assert.equal(count(), before, "no rows written by failed records");
  assert.ok(ext, "fixture used");
});

test("get round-trips; unknown and malformed ids fail closed", t => {
  const store = freshStore(t);
  const written = store.emissaryReceipts.record(ROOM, { kind: "jury", payload: { verdict: "upheld" } });
  const read = store.emissaryReceipts.get(ROOM, written.receipt_id);
  assert.deepEqual(read, written);
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.get(ROOM, "ert1." + "d".repeat(32))),
    { status: 404, code: "unknown_receipt" });
  assert.deepEqual(serviceError(() => store.emissaryReceipts.get(ROOM, "bogus")),
    { status: 422, code: "invalid_emissary_input" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.get("nope", written.receipt_id)),
    { status: 404, code: "unknown_room" });
});

test("listByExternal is deterministic, kind-filterable, paginated", t => {
  const store = freshStore(t);
  const ext = external(t, store);
  const other = external(t, store);
  const ids = [];
  const kinds = ["work", "work", "jury", "oracle", "work"];
  for (const kind of kinds) {
    ids.push(store.emissaryReceipts.record(ROOM, { externalId: ext, kind }).receipt_id);
  }
  store.emissaryReceipts.record(ROOM, { externalId: other, kind: "work" });
  const all = store.emissaryReceipts.listByExternal(ROOM, ext);
  assert.equal(all.length, 5);
  assert.ok(all.every(r => r.external_id === ext), "no cross-identity leakage");
  const again = store.emissaryReceipts.listByExternal(ROOM, ext);
  assert.deepEqual(again.map(r => r.receipt_id), all.map(r => r.receipt_id),
    "repeated reads return identical order");
  const keys = all.map(r => [r.created_at, r.receipt_id]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)),
    "created_at ASC, receipt_id ASC");
  const work = store.emissaryReceipts.listByExternal(ROOM, ext, { kind: "work" });
  assert.equal(work.length, 3);
  assert.ok(work.every(r => r.kind === "work"));
  const page1 = store.emissaryReceipts.listByExternal(ROOM, ext, { limit: 2, offset: 0 });
  const page2 = store.emissaryReceipts.listByExternal(ROOM, ext, { limit: 2, offset: 2 });
  const page3 = store.emissaryReceipts.listByExternal(ROOM, ext, { limit: 2, offset: 4 });
  assert.deepEqual(
    [...page1, ...page2, ...page3].map(r => r.receipt_id),
    all.map(r => r.receipt_id), "pages tile the full list");
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.listByExternal(ROOM, "ex1." + "e".repeat(32))),
    { status: 404, code: "unknown_external" });
  assert.deepEqual(serviceError(() =>
    store.emissaryReceipts.listByExternal(ROOM, ext, { kind: "bogus" })),
    { status: 422, code: "invalid_emissary_input" });
  assert.ok(ids.length, "fixtures used");
});

test("listByOffer returns exactly that offer's receipts", t => {
  const store = freshStore(t);
  const ext = external(t, store);
  const a1 = store.emissaryReceipts.record(ROOM, { externalId: ext, offerId: "offer-a", kind: "work" });
  const a2 = store.emissaryReceipts.record(ROOM, { externalId: ext, offerId: "offer-a", kind: "jury" });
  store.emissaryReceipts.record(ROOM, { externalId: ext, offerId: "offer-b", kind: "work" });
  const found = store.emissaryReceipts.listByOffer(ROOM, "offer-a");
  assert.deepEqual(found.map(r => r.receipt_id).sort(), [a1.receipt_id, a2.receipt_id].sort());
  assert.equal(store.emissaryReceipts.listByOffer(ROOM, "offer-empty").length, 0);
  assert.deepEqual(serviceError(() => store.emissaryReceipts.listByOffer(ROOM, "")),
    { status: 422, code: "invalid_emissary_input" });
});

test("reassignExternal moves every receipt between identities", t => {
  const store = freshStore(t);
  const from = external(t, store);
  const to = external(t, store);
  const r1 = store.emissaryReceipts.record(ROOM, { externalId: from, kind: "work" });
  const r2 = store.emissaryReceipts.record(ROOM, { externalId: from, kind: "jury" });
  const result = store.emissaryReceipts.reassignExternal(ROOM, from, to);
  assert.equal(result.reassigned, 2);
  assert.equal(store.emissaryReceipts.get(ROOM, r1.receipt_id).external_id, to);
  assert.equal(store.emissaryReceipts.get(ROOM, r2.receipt_id).external_id, to);
  assert.equal(store.emissaryReceipts.listByExternal(ROOM, from).length, 0);
  const again = store.emissaryReceipts.reassignExternal(ROOM, from, to);
  assert.equal(again.reassigned, 0, "idempotent when nothing matches");
});
