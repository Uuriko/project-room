import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { roomDocsEnabled, listDocs, getDoc } from "../server/room-docs.mjs";
import { getRoomDocs, getRoomDoc, postRoomDoc, ROOM_DOC_ROUTES } from "../server/routes/room-docs.mjs";
import { ROUTES } from "../server/routes/table.mjs";

const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); delete process.env.ROOM_DOCS; });
  const call = async (handler, { memberId = "lead", docId, body, query = "" } = {}) => {
    const ctx = { roomDocsEnabled: process.env.ROOM_DOCS === "1", params: { roomId: "commons", docId }, req: {}, res: {}, url: new URL(`https://room.example/x${query}`), store,
      roomCredentials: () => ({ mode: "room", bearer: false }), expectedBinding: () => null, accountBinding: () => null,
      roomAuth: () => ({ member: { id: memberId }, credentialScope: "room", credentialHash: memberId }),
      protectWrite: () => {}, rate: () => {}, body: async () => body, json: (_r, status, value) => ({ status, value }), reject };
    try { return await handler(ctx); } catch (e) { if (!Number.isInteger(e.status)) throw e; return { status: e.status, code: e.code }; }
  };
  return { call };
}

test("routes are in the table and 404 with the flag off", async t => {
  assert.equal(roomDocsEnabled({}), false);
  for (const r of ROOM_DOC_ROUTES) assert.ok(ROUTES.includes(r));
  const f = fixture(t);
  assert.equal((await f.call(getRoomDocs)).status, 404);
  assert.equal((await f.call(postRoomDoc, { docId: "runbook", body: { title: "R", body: "x", baseRev: 0 } })).status, 404);
});

test("flag on: create, update, read history, list", async t => {
  process.env.ROOM_DOCS = "1";
  const f = fixture(t);
  const made = await f.call(postRoomDoc, { docId: "runbook", body: { title: "Runbook", body: "v1", baseRev: 0 } });
  assert.equal(made.status, 201);
  assert.equal(made.value.doc.rev, 1);
  const upd = await f.call(postRoomDoc, { memberId: "other", docId: "runbook", body: { title: "Runbook", body: "v2", baseRev: 1 } });
  assert.deepEqual([upd.status, upd.value.doc.rev, upd.value.doc.updatedBy], [200, 2, "other"]);
  assert.equal((await f.call(getRoomDoc, { docId: "runbook" })).value.doc.body, "v2");
  assert.equal((await f.call(getRoomDoc, { docId: "runbook", query: "?rev=1" })).value.doc.body, "v1");
  const list = await f.call(getRoomDocs);
  assert.deepEqual(list.value.docs.map(d => [d.docId, d.rev]), [["runbook", 2]]);
  assert.equal(list.value.docs[0].body, undefined);
});

test("flag on: stale writes conflict, bad input and unknown docs are refused", async t => {
  process.env.ROOM_DOCS = "1";
  const f = fixture(t);
  await f.call(postRoomDoc, { docId: "spec", body: { title: "Spec", body: "a", baseRev: 0 } });
  assert.deepEqual(await f.call(postRoomDoc, { docId: "spec", body: { title: "Spec", body: "b", baseRev: 0 } }), { status: 409, code: "doc_rev_conflict" });
  assert.equal((await f.call(postRoomDoc, { docId: "spec", body: { title: "Spec", body: "b", baseRev: 5 } })).code, "doc_rev_conflict");
  assert.equal((await f.call(getRoomDoc, { docId: "spec" })).value.doc.body, "a");
  assert.equal((await f.call(postRoomDoc, { docId: "Bad_ID", body: { title: "x", body: "", baseRev: 0 } })).code, "invalid_body");
  assert.equal((await f.call(postRoomDoc, { docId: "ok", body: { title: "", body: "", baseRev: 0 } })).code, "invalid_body");
  assert.equal((await f.call(postRoomDoc, { docId: "ok", body: { title: "t", body: "x".repeat(50_001), baseRev: 0 } })).code, "invalid_body");
  assert.equal((await f.call(getRoomDoc, { docId: "nope" })).code, "unknown_doc");
  assert.equal((await f.call(getRoomDoc, { docId: "spec", query: "?rev=9" })).code, "unknown_doc");
  assert.equal((await f.call(getRoomDoc, { docId: "spec", query: "?rev=0" })).code, "invalid_body");
});

 test("reading an uninitialized document store performs no DDL", t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  const schema = () => store.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  const before = schema();
  assert.deepEqual(listDocs(store.db, { roomId: "commons" }), { docs: [], hasMore: false, nextAfter: null });
  assert.equal(getDoc(store.db, { roomId: "commons", docId: "spec" }), null);
  assert.equal(getDoc(store.db, { roomId: "commons", docId: "spec", rev: 1 }), null);
  assert.deepEqual(schema(), before);
});
