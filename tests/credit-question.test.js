import test from "node:test";
import assert from "node:assert/strict";
import { creditQuestion, replyDraftKey, replyDraftData, validReplyDraft } from "../src/reply-requests.js";
import { ConversationDrafts, DraftRecovery } from "../src/conversation.js";
import { draftCommand } from "../src/client.js";

function fixture() {
  return { members: { owner: {}, reviewer: {} }, messages: [{ id: "text", workItemId: "work" }],
    workItems: { work: { receipt: { eventId: "result", reportedById: "owner", producerId: null, producerAttribution: "external-reported",
      externalProducer: "Outside author + AI", nativeText: { messageId: "text" } }, receiptHistory: [] } } };
}
test("credit questions use existing reply semantics, exact text and separate draft identities", () => {
  const state = fixture(), before = structuredClone(state), q = creditQuestion(state, "work", "reviewer", "result");
  assert.equal(q.toMemberId, "owner"); assert.equal(q.replyToId, "text"); assert.ok(validReplyDraft(q.mode, state));
  const data = replyDraftData(q.mode, { body: q.body, toMemberId: "owner", replyToId: "unrelated", messageId: "question" });
  assert.deepEqual(data, { body: q.body, toMemberId: "owner", replyToId: "text", messageId: "question", workItemId: "work", requestKind: "reply" });
  assert.deepEqual(state, before);
  assert.equal(new Set([replyDraftKey(q.mode), replyDraftKey({ kind: "request" }, "text"),
    replyDraftKey({ ...q.mode, resultEventId: "other" }), "text", null]).size, 5);
  for (const patch of [{ workItemId: "missing" }, { resultEventId: "missing" }, { resultMessageId: "unrelated" }, { extra: true }])
    assert.equal(Boolean(validReplyDraft({ ...q.mode, ...patch }, state)), false);
});
test("missing, stale and self-directed defaults do not invent a recipient or identity", () => {
  const state = fixture();
  assert.equal(creditQuestion(state, "work", "reviewer", "old"), null);
  assert.equal(creditQuestion(state, "work", "missing", "result"), null);
  assert.equal(creditQuestion(state, "work", "owner", "result").toMemberId, "");
  state.members.owner.active = false;
  assert.equal(creditQuestion(state, "work", "reviewer", "result").toMemberId, "");
  delete state.workItems.work.receipt.nativeText;
  state.workItems.work.receipt.evidenceUrl = "x".repeat(4096);
  state.workItems.work.receipt.evidenceVersion = "v".repeat(4096);
  const q = creditQuestion(state, "work", "reviewer", "result");
  assert.equal(q.replyToId, null); assert.ok(q.body.length < 4000); assert.match(q.body, /Result record: result/);
});
test("saved result questions and unknown retries recover after a newer result without rebasing", () => {
  const state = fixture(), q = creditQuestion(state, "work", "reviewer", "result"), key = replyDraftKey(q.mode);
  const memory = new Map(), recovery = new DraftRecovery({ getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v), removeItem: k => memory.delete(k) }, () => 1000);
  const drafts = new ConversationDrafts(), data = replyDraftData(q.mode, { ...q, messageId: "question" });
  const pending = draftCommand(null, "message.posted", data);
  drafts.save(key, { ...q, threadId: "text", pending }); drafts.save(null, { body: "Unrelated writing" });
  recovery.write("scope", drafts, "text", key);
  state.workItems.work.receiptHistory.push(state.workItems.work.receipt);
  state.workItems.work.receipt = { ...state.workItems.work.receipt, eventId: "new-result" };
  const restored = recovery.read("scope", state);
  assert.equal(restored.activeKey, key); assert.deepEqual(restored.drafts.get(key).pending, pending);
  assert.equal(restored.drafts.get(null).body, "Unrelated writing");
  const saved = JSON.parse(memory.get(recovery.key)); saved.entries.find(([k]) => k === key)[1].replyToId = null;
  memory.set(recovery.key, JSON.stringify(saved));
  assert.equal(recovery.read("scope", state).drafts.entries.has(key), false);
});
