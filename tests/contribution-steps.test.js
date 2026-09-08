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

function draftFixture() {
  const state = fixture();
  state.members.guest.permissions.push('complete_work');
  Object.assign(state.workItems.assigned, { state: 'accepted', revision: 2 });
  state.messages.push({ id: 'draft', workItemId: 'assigned', authorId: 'author', body: 'A useful draft',
    proposal: { basisRevision: 2, submittedAtRevision: 2 }, createdAt: '2026-09-08T12:10:00Z' });
  return state;
}
test('current contributed draft replaces start and creates one working-work return step', () => {
  const state = draftFixture(), before = structuredClone(state);
  const draft = contributionSteps(state, 'guest').find(step => step.id === 'assigned');
  assert.equal(draft.draftMessageId, 'draft'); assert.equal(draft.label, 'Draft to inspect');
  assert.equal(draft.button, 'View draft'); assert.equal(draft.action, null);
  assert.deepEqual(contributionSteps(state, 'guest').map(step => step.key), ['work:review', 'request:question', 'work:assigned']);
  assert.deepEqual(state, before);
  state.workItems.assigned.state = 'working';
  assert.deepEqual(contributionSteps(state, 'guest').filter(step => step.id === 'assigned'), [draft]);
  state.readMarkers = { guest: 999 };
  assert.equal(contributionSteps(state, 'guest').find(step => step.id === 'assigned').draftMessageId, 'draft');
});
test('draft suggestions use the latest canonical proposal and never quietly select an older current draft', () => {
  const state = draftFixture();
  state.messages.push({ ...structuredClone(state.messages.at(-1)), id: 'newer', createdAt: '2026-09-08T11:00:00Z' });
  assert.equal(contributionSteps(state, 'guest').find(step => step.id === 'assigned').draftMessageId, 'newer');
  const alternatives = contributionSteps(state, 'guest').find(step => step.id === 'assigned');
  assert.equal(alternatives.draftCount, 2); assert.equal(alternatives.button, 'View drafts');
  assert.equal(alternatives.label, 'Drafts to inspect');
  assert.equal(contributionSteps(state, 'guest').filter(step => step.id === 'assigned').length, 1);
  for (const basis of [1, 3, undefined]) {
    state.messages.at(-1).proposal.basisRevision = basis;
    assert.equal(contributionSteps(state, 'guest').find(step => step.id === 'assigned').draftMessageId, undefined);
  }
  state.messages.at(-1).proposal.basisRevision = 2;
  state.messages.push({ id: 'ordinary', workItemId: 'assigned', body: 'Just a comment' });
  assert.equal(contributionSteps(state, 'guest').find(step => step.id === 'assigned').draftMessageId, 'newer');
  state.messages = state.messages.filter(message => !message.proposal);
  assert.equal(contributionSteps(state, 'guest').find(step => step.id === 'assigned').draftMessageId, undefined);
});
test('draft return respects acceptance, current permissions, write scope and retired work', () => {
  const state = draftFixture(), hasDraft = () => contributionSteps(state, 'guest', 1000).some(step => step.draftMessageId);
  for (const stateName of ['proposed', 'blocked', 'completed', 'superseded']) {
    state.workItems.assigned.state = stateName; assert.equal(hasDraft(), false, stateName);
  }
  state.workItems.assigned.state = 'accepted'; state.workItems.assigned.supersededBy = 'replacement';
  assert.equal(hasDraft(), false); delete state.workItems.assigned.supersededBy;
  state.members.guest.permissions = ['accept_work']; assert.equal(hasDraft(), false);
  state.members.guest.permissions.push('complete_work'); assert.equal(hasDraft(), true);
  state.workItems.assigned.mode = 'write'; assert.equal(hasDraft(), false);
  state.members.guest.permissions.push('write_external');
  state.workItems.assigned.claim = { holderId: 'guest', status: 'active', expiresAt: new Date(2000).toISOString() };
  assert.equal(hasDraft(), true);
  state.workItems.assigned.claim.expiresAt = new Date(1000).toISOString(); assert.equal(hasDraft(), false);
  state.workItems.assigned.mode = 'read'; state.workItems.assigned.accountableMemberId = 'other'; assert.equal(hasDraft(), false);
});
