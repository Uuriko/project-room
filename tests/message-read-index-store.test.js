import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { messageReadIndex } from "../server/message-read-index.mjs";

test("rollback and same-sequence replacement cannot reuse a stale message index", t => {
  const store = new RoomStore(":memory:"); store.initialize(initialRoom()); t.after(() => store.close());
  const token = store.issueAccessKey("commons", "owner");
  const post = (id, body) => store.command(token, "commons", { id, type: "message.posted", data: { messageId: id, body } });
  post("kept", "committed");
  const before = messageReadIndex(store.room("commons").state.messages);
  assert.throws(() => store.transaction(() => {
    post("rolled-back", "must disappear");
    assert.equal(messageReadIndex(store.room("commons").state.messages).get("rolled-back").body, "must disappear");
    throw new Error("rollback fixture");
  }), /rollback fixture/);
  assert.equal(messageReadIndex(store.room("commons").state.messages).get("rolled-back"), undefined);
  const head = store.headSequence("commons");
  store.transaction(() => store.db.prepare("UPDATE rooms SET projection=json_set(projection, '$.messages[0].body', ?) WHERE id=?")
    .run("same-sequence replacement", "commons"));
  const after = messageReadIndex(store.room("commons").state.messages);
  assert.notEqual(after, before); assert.equal(store.headSequence("commons"), head);
  assert.equal(after.get("kept").body, "same-sequence replacement");
  assert.equal(store.roomDigest(token, "commons").messages.find(m => m.id === "kept").summary, "same-sequence replacement");
});
