import test from "node:test";
import assert from "node:assert/strict";
import { draftFeedback } from "../src/work-selectors.js";

function fixture() {
  const message = { id: "draft", authorId: "guest", workItemId: "work", proposal: { basisRevision: 1 } };
  const receipt = { eventId: "completion", evidenceVersion: "v1", producerAttribution: "reported", producerId: "guest",
    nativeText: { messageId: "draft", postedById: "guest" } };
  const item = { id: "work", state: "completed", receipt, receiptHistory: [], ownerDecisionRequired: true,
    independentVerificationRequired: true, verifierMemberId: "reviewer" };
  const binding = { completionEventId: "completion", evidenceVersion: "v1" };
  return { message, item, binding };
}
test("only the exact adopted message gets current review and decision feedback", () => {
  const { item, message, binding } = fixture(), before = structuredClone(item);
  assert.equal(draftFeedback(item, message).label, "Awaiting review");
  assert.equal(draftFeedback(item, { ...message, id: "alternative" }).label, "Draft");
  assert.equal(draftFeedback(item, { ...message, authorId: "other" }).label, "Draft");
  assert.equal(draftFeedback(item, { ...message, workItemId: "elsewhere" }), null);
  assert.equal(draftFeedback(item, { ...message, proposal: null }), null);
  assert.deepEqual(item, before);
  item.verification = { ...binding, result: "pass", verifierId: "reviewer", independenceConfirmed: true };
  assert.equal(draftFeedback(item, message).label, "Awaiting decision");
  item.decision = { ...binding, decision: "approved", reason: "Ready" };
  assert.deepEqual(draftFeedback(item, message), { label: "Approved", reason: "Ready" });
  item.decision.evidenceVersion = "other";
  assert.equal(draftFeedback(item, message).label, "Awaiting decision");
  item.verification.evidenceVersion = "other";
  assert.equal(draftFeedback(item, message).label, "Awaiting review");
});
test("findings and changes are tied to the current blocker and exact result", () => {
  const { item, message, binding } = fixture();
  item.state = "blocked"; item.blocker = { eventId: "decision", reason: "New scope" };
  item.decision = { ...binding, eventId: "decision", decision: "changes_requested", reason: "Name the reviewer" };
  assert.deepEqual(draftFeedback(item, message), { label: "Changes requested", reason: "Name the reviewer" });
  item.decision.decision = "rejected";
  assert.equal(draftFeedback(item, message).label, "Not accepted");
  item.decision.evidenceVersion = "old";
  assert.deepEqual(draftFeedback(item, message), { label: "Work reopened", reason: "New scope" });
  item.verification = { ...binding, eventId: "check", result: "fail", summary: "<literal finding>" };
  item.blocker.eventId = "check";
  assert.deepEqual(draftFeedback(item, message), { label: "Review finding", reason: "<literal finding>" });
  item.state = "accepted";
  assert.deepEqual(draftFeedback(item, message), { label: "Work reopened", reason: null });
});
test("replacement never transfers approval or rejection to other drafts", () => {
  const { item, message, binding } = fixture();
  item.decision = { ...binding, decision: "approved", reason: "Ready" };
  item.receiptHistory.push(item.receipt);
  item.receipt = { ...item.receipt, eventId: "new-completion", evidenceVersion: "v2", nativeText: { messageId: "new-draft", postedById: "guest" } };
  assert.deepEqual(draftFeedback(item, message), { label: "Earlier result", reason: null });
  assert.equal(draftFeedback(item, { ...message, id: "new-draft" }).label, "Awaiting review");
  assert.equal(draftFeedback(item, { ...message, id: "unused-draft" }).label, "Draft");
});
test("terminal and exceptional work states do not fabricate human approval", () => {
  const { item, message } = fixture();
  item.ownerDecisionRequired = false; item.independentVerificationRequired = false;
  assert.equal(draftFeedback(item, message).label, "Completed");
  item.supersededBy = "replacement";
  assert.equal(draftFeedback(item, message).label, "Work replaced");
  delete item.supersededBy; item.independentVerificationRequired = true; item.receipt.producerId = null;
  assert.equal(draftFeedback(item, message).label, "Saved as result");
});
