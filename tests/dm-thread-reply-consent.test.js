// r232 (John's Tab QA, pair returning member x after-hours): a blocked
// member could keep messaging the person who blocked them by replying to an
// old DM thread. store.command checks DM consent only when the command
// carries toMemberId, and CH-2011 stamps a DM-thread reply with the thread's
// other party later in the same admission, after that check. The reply
// landed as a DM to the blocker and showed up in their activity feed.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function seeded(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [id, name] of [["ada", "Ada"], ["bot", "Nightbot"]]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId: id, displayName: name, kind: id === "bot" ? "agent" : "human", permissions: ["steer"] } });
  }
  const botKey = store.issueAccessKey("commons", "bot");
  const adaKey = store.issueAccessKey("commons", "ada");
  // Default-open: the bot DMs Ada before any consent row exists.
  store.command(botKey, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: "dm-root", body: "hi Ada", toMemberId: "ada" } });
  return { store, botKey, adaKey };
}

const post = (store, key, data) => {
  try { store.command(key, "commons", { id: randomUUID(), type: "message.posted", data }); return null; }
  catch (error) { return error; }
};

test("a blocked member cannot reach the blocker by replying in an old DM thread", t => {
  const { store, botKey } = seeded(t);
  store.dmConsents.block("commons", "ada", "bot");
  const direct = post(store, botKey, { messageId: "dm-new", body: "new DM", toMemberId: "ada" });
  assert.equal(direct?.code, "dm_blocked", "a fresh DM is refused");
  const reply = post(store, botKey, { messageId: "dm-reply", body: "thread reply after block", replyToId: "dm-root" });
  assert.equal(reply?.code, "dm_blocked", "a DM-thread reply is a DM to the blocker and must be refused too");
  const landed = store.room("commons").state.messages.find(m => m.id === "dm-reply");
  assert.equal(landed, undefined, "the refused reply must not persist");
});

test("the blocker can still reply in the thread, and unblocked parties keep threading", t => {
  const { store, botKey, adaKey } = seeded(t);
  assert.equal(post(store, botKey, { messageId: "r1", body: "follow-up", replyToId: "dm-root" }), null);
  assert.equal(store.room("commons").state.messages.find(m => m.id === "r1")?.toMemberId, "ada", "CH-2011 stamp kept");
  store.dmConsents.block("commons", "ada", "bot");
  assert.equal(post(store, adaKey, { messageId: "r2", body: "ada answers", replyToId: "dm-root" }), null, "the blocker's own direction is not denied");
  assert.equal(store.room("commons").state.messages.find(m => m.id === "r2")?.toMemberId, "bot");
});
