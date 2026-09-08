import test from "node:test";
import assert from "node:assert/strict";
import { contributionSteps } from "../src/work-selectors.js";

function fixture() {
  const item = { id: "review", title: "Review this", state: "completed", mode: "read", accountableMemberId: "author", verifierMemberId: "guest",
    independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner",
    receipt: { eventId: "result", evidenceVersion: "v1", producerAttribution: "reported", producerId: "author" }, updatedAt: "2026-09-08T12:00:00Z" };
  return { members: { guest: { id: "guest", kind: "human", permissions: ["verify", "accept_work"] } },
    messages: [{ id: "question", body: "Which option?" }],
    replyRequests: { question: { id: "question", recipientId: "guest", status: "open", createdAt: "2026-09-08T10:00:00Z" } },
    workItems: { review: item, assigned: { ...item, id: "assigned", title: "A small contribution", accountableMemberId: "guest", state: "proposed", receipt: null } } };
}
test("contribution steps prioritize review, explicit questions and assigned work without mutating facts", () => {
  const state = fixture(), before = structuredClone(state);
  const steps = contributionSteps(state, "guest", 0);
  assert.deepEqual(steps.map(step => step.key), ["work:review", "request:question", "work:assigned"]);
  assert.equal(steps[0].action, "verify"); assert.equal(steps[2].action, "accept");
  assert.deepEqual(state, before);
  assert.deepEqual(contributionSteps(state, "unknown"), []);
  state.members.guest.active = false; assert.deepEqual(contributionSteps(state, "guest"), []);
});
test("read markers do not resolve contributions; terminal requests and satisfied reviews do", () => {
  const state = fixture(); state.readMarkers = { guest: 999 };
  assert.equal(contributionSteps(state, "guest").length, 3);
  state.replyRequests.question.status = "answered";
  state.workItems.review.verification = { result: "pass", completionEventId: "result", evidenceVersion: "v1", verifierId: "guest", independenceConfirmed: true };
  assert.deepEqual(contributionSteps(state, "guest").map(step => step.id), ["assigned"]);
  state.workItems.assigned.supersededBy = "other";
  assert.deepEqual(contributionSteps(state, "guest"), []);
});
test("removed permissions keep a read destination, not a privileged form shortcut", () => {
  const state = fixture(); state.members.guest.permissions = [];
  const steps = contributionSteps(state, "guest");
  assert.equal(steps.find(step => step.id === "review").action, null);
  assert.equal(steps.find(step => step.id === "assigned").action, null);
  state.replyRequests.question.recipientId = "other";
  assert.equal(contributionSteps(state, "guest").some(step => step.kind === "request"), false);
});
test("same-priority choices remain deterministic, independent of object insertion order", () => {
  const state = fixture();
  state.workItems.another = { ...state.workItems.assigned, id: "another" };
  const before = contributionSteps(state, "guest");
  state.workItems = Object.fromEntries(Object.entries(state.workItems).reverse());
  assert.deepEqual(contributionSteps(state, "guest"), before);
});
