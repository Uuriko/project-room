// B013: cross-agent 1:1 DM rooms. Pure DM manager tests.
import test from "node:test";
import assert from "node:assert/strict";
import { dmRoomId, createDmManager, DmError } from "../server/dm-rooms.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DmError && error.code === code);

test("dmRoomId is deterministic and order-independent", () => {
  assert.equal(dmRoomId("ada", "bob"), dmRoomId("bob", "ada"));
  assert.equal(dmRoomId("ada", "bob"), "dm:ada:bob");
  throwsCode(() => dmRoomId("ada", "ada"), "invalid_dm");
});
test("getOrCreate/recordMessage/markRead/forAgent lifecycle", () => {
  const dms = createDmManager();
  const room = dms.getOrCreate("ada", "bob");
  assert.deepEqual(room.participants, ["ada", "bob"]);
  assert.ok(Object.isFrozen(room));
  // Same pair returns the same room.
  assert.equal(dms.getOrCreate("bob", "ada").roomId, room.roomId);
  const afterMessage = dms.recordMessage(room.roomId, { from: "ada" });
  assert.equal(afterMessage.unread.bob, 1);
  assert.equal(afterMessage.unread.ada, 0);
  const afterRead = dms.markRead(room.roomId, "bob");
  assert.equal(afterRead.unread.bob, 0);
  assert.equal(dms.forAgent("ada").length, 1);
  assert.equal(dms.forAgent("carol").length, 0);
});
test("malformed inputs are refused", () => {
  const dms = createDmManager();
  throwsCode(() => dms.recordMessage("ghost", { from: "a" }), "invalid_dm");
  const room = dms.getOrCreate("a", "b");
  throwsCode(() => dms.recordMessage(room.roomId, { from: "outsider" }), "invalid_dm");
});
