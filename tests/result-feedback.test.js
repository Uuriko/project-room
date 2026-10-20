import test from "node:test";
import assert from "node:assert/strict";
import { createResultFeedback } from "../src/result-feedback.js";

function fixture() {
  const message = { id: "result", channelId: "design" };
  const state = { room: {}, channels: { design: {} }, messages: [message] };
  const calls = [];
  let draft, blocked = false;
  const conversation = { rootById: new Map([["result", "thread"]]), threads: new Map([["thread", {}]]) };
  const reply = createResultFeedback({ getState: () => state, getConversation: () => conversation,
    isBlocked: () => blocked, getDraft: () => draft, onBlocked: () => calls.push("blocked"),
    openThread: (message, destination) => calls.push(["open", message.id, destination]),
    setReply: id => calls.push(["reply", id]) });
  return { state, message, calls, conversation, reply, draft: value => { draft = value; }, block: () => { blocked = true; } };
}

test("result feedback opens the original thread then selects exact result, including an untouched destination", () => {
  const f = fixture();
  assert.equal(f.reply("result"), true);
  assert.deepEqual(f.calls, [["open", "result", "thread"], ["reply", "result"]]);
});
test("private or sending destination drafts prevent navigation and remain unchanged", () => {
  for (const draft of [{ toMemberId: "private", body: "secret" }, { pending: true, body: "sending" }]) {
    const f = fixture(); f.draft(Object.freeze(draft));
    assert.equal(f.reply("result"), false);
    assert.deepEqual(f.calls, ["blocked"]);
  }
});
test("a public draft is preserved while routing feedback", () => {
  const f = fixture(); const draft = Object.freeze({ body: "Keep my unfinished feedback", files: ["attachment"] });
  f.draft(draft); assert.equal(f.reply("result"), true);
  assert.equal(draft.body, "Keep my unfinished feedback");
});
test("withdrawn, private, archived and unknown results never navigate", () => {
  for (const change of [f => { f.message.deletedAt = 1; }, f => { f.message.toMemberId = "private"; },
    f => { f.state.room.archivedAt = "2026-10-19T00:00:00Z"; }, f => { f.state.channels.design.archivedAt = 1; },
    f => { f.state.messages = []; }, f => f.conversation.threads.clear(), f => f.block()]) {
    const f = fixture(); change(f); assert.equal(f.reply("result"), false); assert.deepEqual(f.calls, []);
  }
});
test("eligibility is rechecked after a previously valid result is withdrawn", () => {
  const f = fixture(); assert.equal(f.reply("result"), true); f.calls.length = 0;
  f.message.deletedAt = 1; assert.equal(f.reply("result"), false); assert.deepEqual(f.calls, []);
});

test("feedback never retargets a composed reply to another message", () => {
  for (const content of [{ body: "Answer to someone else" }, { files: ["attachment"] }]) {
    const f = fixture();
    f.draft(Object.freeze({ replyToId: "other-message", ...content }));
    assert.equal(f.reply("result"), false);
    assert.deepEqual(f.calls, ["blocked"]);
  }
});
test("feedback continues a draft already addressing this result", () => {
  const f = fixture(); f.draft({ replyToId: "result", body: "My feedback", files: ["attachment"] });
  assert.equal(f.reply("result"), true);
  assert.deepEqual(f.calls, [["open", "result", "thread"], ["reply", "result"]]);
});
test("an empty reply selection can be retargeted", () => {
  const f = fixture(); f.draft({ replyToId: "other-message", body: "  ", files: [] });
  assert.equal(f.reply("result"), true);
});
