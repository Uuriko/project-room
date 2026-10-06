import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { encodeProjection, decodeProjection, BODY_AT_REST, bodiesAtRestEnabled } from "../server/projection-codec.mjs";
import { MESSAGES_SCHEMA } from "../server/messages-store.mjs";

const LONG = "hello world ".repeat(40);
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY)");
  db.exec(MESSAGES_SCHEMA);
  db.prepare("INSERT INTO rooms(id) VALUES ('r1')").run();
  const put = db.prepare("INSERT INTO messages (room_id, message_id, seq, author_id, body, created_at) VALUES ('r1', ?, ?, 'a', ?, '2026-10-06T00:00:00Z')");
  put.run("m1", 1, LONG);
  put.run("m2", 2, "edited in table");       // projection still has the pre-edit body
  put.run("m4", 4, "a private note");        // DM
  const state = { room: { id: "r1" }, members: { a: {} }, messages: [
    { id: "m1", authorId: "a", body: LONG, createdAt: "x" },
    { id: "m2", authorId: "a", body: "old body", createdAt: "x" },
    { id: "m3", authorId: "a", body: "not in table yet", createdAt: "x" },
    { id: "m4", authorId: "a", body: "a private note", toMemberId: "b", createdAt: "x" },
    { id: "m5", authorId: "a", body: null, deletedAt: "y", createdAt: "x" }
  ] };
  return { db, state };
}

test("flag off: encode is plain JSON.stringify", () => {
  const { db, state } = fixture();
  assert.equal(encodeProjection(db, "r1", state, { enabled: false }), JSON.stringify(state));
  assert.equal(bodiesAtRestEnabled({}), false);
  assert.equal(bodiesAtRestEnabled({ PROJECTION_BODIES_AT_REST: "1" }), true);
});

test("only byte-equal bodies leave the row; round trip is exact", () => {
  const { db, state } = fixture();
  const text = encodeProjection(db, "r1", state, { enabled: true });
  const stored = JSON.parse(text);
  const by = Object.fromEntries(stored.messages.map(m => [m.id, m]));
  assert.equal(by.m1.body, null); assert.equal(by.m1[BODY_AT_REST], 1);
  assert.equal(by.m2.body, "old body", "a body that differs from the table stays inline");
  assert.equal(by.m3.body, "not in table yet", "a body missing from the table stays inline");
  assert.equal(by.m4[BODY_AT_REST], 1);
  assert.equal(by.m5.body, null, "a deleted message is untouched");
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(state)));
  assert.deepEqual(decodeProjection(db, "r1", text), state);
  assert.equal(JSON.stringify(decodeProjection(db, "r1", text)), JSON.stringify(state), "re-serialized bytes equal (key order kept)");
});

test("a missing table body degrades only that message and reports it", () => {
  const { db, state } = fixture();
  const text = encodeProjection(db, "r1", state, { enabled: true });
  db.prepare("DELETE FROM messages WHERE message_id='m1'").run();
  const seen = [];
  const back = decodeProjection(db, "r1", text, { onMissing: e => seen.push(e) });
  const m1 = back.messages.find(m => m.id === "m1");
  assert.equal(m1.body, null); assert.equal(m1.bodyUnavailable, true); assert.equal(m1[BODY_AT_REST], undefined);
  assert.equal(back.messages.find(m => m.id === "m4").body, "a private note");
  assert.deepEqual(seen, [{ roomId: "r1", messageIds: ["m1"] }]);
});

test("decode accepts a legacy inline row unchanged", () => {
  const { db, state } = fixture();
  assert.deepEqual(decodeProjection(db, "r1", JSON.stringify(state)), state);
});
