// History hint on first read: a cold room_read_messages (no after, not
// latest) carries the caller's existing catch-up marker so a joining or woken
// agent can go straight to unhandled messages in one more read.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  store.command(keys.owner, "commons", { id: "join-w", type: "member.added",
    data: { memberId: "worker1", displayName: "Worker 1", kind: "agent", permissions: [] } });
  keys.worker1 = store.issueAccessKey("commons", "worker1");
  const post = (actor, messageId) => store.command(keys[actor], "commons",
    { id: `post-${messageId}`, type: "message.posted", data: { messageId, body: messageId } });
  const read = (args, member = "worker1") =>
    callHostedStdioTool(store, keys[member], "room_read_messages", { roomId: "commons", ...args }).then(r => r.value);
  return { store, keys, post, read };
}

test("no saved marker: cold read has no hint", async t => {
  const f = fixture(t);
  f.post("owner", "a");
  const page = await f.read({});
  assert.equal(page.catchUp, undefined);
});

test("saved marker: cold read points at it; one follow-up read returns only unhandled messages", async t => {
  const f = fixture(t);
  for (const id of ["old-1", "old-2", "old-3"]) f.post("owner", id);
  const handled = f.store.room("commons").sequence;
  f.store.markCaughtUp(f.keys.worker1, "commons", handled);
  f.post("owner", "new-reply");
  const cold = await f.read({ limit: 2 });
  assert.equal(cold.catchUp.after, handled);
  assert.equal(cold.catchUp.acknowledges, false);
  assert.equal(cold.catchUp.nextRead.tool, "room_read_messages");
  assert.equal("newerCount" in cold.catchUp, false, "no guessed counts");
  const next = await f.read(cold.catchUp.nextRead.arguments);
  assert.deepEqual(next.messages.map(m => m.messageId), ["new-reply"]);
  assert.equal(next.catchUp, undefined, "explicit after carries no hint");
  // The woken agent answers using only the hint plus that one read.
  const target = next.messages[0];
  const answered = await callHostedStdioTool(f.store, f.keys.worker1, "room_reply",
    { roomId: "commons", replyToId: target.messageId, body: "answered from catch-up" }).then(r => r.value);
  assert.ok(answered.messageId, "reply recorded");
  const after = await f.read({ latest: true, limit: 1 });
  assert.equal(after.messages[0].replyToId, "new-reply");
  // Reading did not move the marker.
  assert.equal(f.store.catchUpCursor("commons", "worker1"), handled);
});

test("latest:true and explicit after:0 carry no hint", async t => {
  const f = fixture(t);
  f.post("owner", "a");
  f.store.markCaughtUp(f.keys.worker1, "commons", f.store.room("commons").sequence);
  f.post("owner", "b");
  assert.equal((await f.read({ latest: true })).catchUp, undefined);
  assert.equal((await f.read({ after: 0 })).catchUp, undefined);
});
