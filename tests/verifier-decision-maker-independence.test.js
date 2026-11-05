import test from "node:test";
import assert from "node:assert/strict";
import { prepareWorkOffer } from "../src/paid-work-offers.js";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T } from "../src/events.js";

// Verifier independence is a relation against the decision-maker as well as
// the producer/accountable member: where an owner decision is required, the
// member who will decide cannot be the designated independent verifier, and
// `independentVerificationRequired: true` must not be asserted otherwise.

function buildRoom() {
  let state = emptyRoomState(), seq = 0;
  const send = (type, actorId, data) => {
    const incoming = event({ type, actorId, data, roomId: "room", at: "2026-10-31T08:00:00Z", id: `ind-${++seq}`, idempotencyKey: `ind-key-${seq}` });
    state = applyEvent(state, incoming); return incoming;
  };
  send(T.ROOM_CREATED, "owner", { roomId: "room", ownerId: "owner", title: "Independence", purpose: "Check verifier exclusion" });
  for (const [memberId, kind, permissions] of [
    ["owner", "human", ["manage_members", "steer", "decide", "verify"]],
    ["producer", "agent", ["accept_work", "complete_work"]],
    ["reviewer", "agent", ["verify"]]]) send(T.MEMBER_ADDED, "owner", { memberId, displayName: memberId, kind, permissions });
  return { get state() { return state; }, send };
}

const propose = (room, overrides = {}) => room.send(T.WORK_PROPOSED, "owner", {
  workItemId: "w1", title: "Work", definitionOfDone: "Done means checked",
  accountableMemberId: "producer", verifierMemberId: "reviewer", humanDecisionMakerId: "owner",
  independentVerificationRequired: true, ownerDecisionRequired: true, mode: "read", ...overrides });

function completeByProducer(room) {
  room.send(T.WORK_ACCEPTED, "producer", { workItemId: "w1" });
  room.send(T.WORK_COMPLETED, "producer", { workItemId: "w1", summary: "Did it", evidenceUrl: "https://example.invalid/x", evidenceVersion: "v1", producerId: "producer", nextAction: "Review" });
  const item = room.state.workItems["w1"];
  return { workItemId: "w1", completionEventId: item.receipt.eventId, evidenceVersion: "v1" };
}

test("propose refuses a verifier who is the designated human decision-maker", () => {
  const room = buildRoom();
  assert.throws(() => propose(room, { verifierMemberId: "owner" }), /different from the human decision-maker/);
  assert.equal(room.state.workItems["w1"], undefined);
});

test("propose still allows the owner as reviewer when no owner decision is required", () => {
  const room = buildRoom();
  propose(room, { verifierMemberId: "owner", ownerDecisionRequired: false });
  assert.equal(room.state.workItems["w1"].verifierMemberId, "owner");
});

test("verification by the decision-maker is refused on an item in the pre-fix shape", () => {
  const room = buildRoom();
  propose(room);
  // Stored-projection shape minted before the exclusion existed: the
  // designated verifier is the deciding human.
  room.state.workItems["w1"].verifierMemberId = "owner";
  const proof = completeByProducer(room);
  assert.throws(() => room.send(T.VERIFICATION_RECORDED, "owner", { ...proof, result: "pass", summary: "Checked" }),
    /different from the human decision-maker/);
  assert.equal(room.state.workItems["w1"].verification, null);
});

test("approval refuses a stored PASS recorded by the decision-maker themself", () => {
  const room = buildRoom();
  propose(room);
  room.state.workItems["w1"].verifierMemberId = "owner";
  const proof = completeByProducer(room);
  // A verification recorded before the exclusion existed.
  room.state.workItems["w1"].verification = { verifierId: "owner", result: "pass", independenceConfirmed: true,
    completionEventId: proof.completionEventId, evidenceVersion: "v1", summary: "Self-checked", eventId: "legacy-verification" };
  assert.throws(() => room.send(T.OWNER_DECISION_RECORDED, "owner", { ...proof, decision: "approved", reason: "Accepted" }),
    /designated independent PASS/);
  assert.equal(room.state.workItems["w1"].decision, null);
});

test("a genuinely independent verifier still verifies and the decider still approves", () => {
  const room = buildRoom();
  propose(room);
  const proof = completeByProducer(room);
  room.send(T.VERIFICATION_RECORDED, "reviewer", { ...proof, result: "pass", summary: "Independently checked" });
  room.send(T.OWNER_DECISION_RECORDED, "owner", { ...proof, decision: "approved", reason: "Accepted" });
  const item = room.state.workItems["w1"];
  assert.equal(item.verification.result, "pass");
  assert.equal(item.decision.decision, "approved");
});

test("paid-work compiler refuses verifier == decision-maker when a human decision is required", () => {
  const brief = { requestId: "req-1", workItemId: "work-1", accountableMemberId: "producer",
    humanDecisionMakerId: "owner", verifierMemberId: "owner", offerId: "research-brief",
    outcome: "Compare options", acceptanceCriteria: ["Primary sources"] };
  assert.throws(() => prepareWorkOffer(brief), /independent of the human decision-maker/);
  const independent = prepareWorkOffer({ ...brief, verifierMemberId: "reviewer" });
  assert.equal(independent.approval.independentVerificationRequired, true);
  assert.notEqual(independent.approval.reviewerMemberId, independent.approval.sponsorMemberId);
});

test("paid-work human review with no separate decision keeps the human as reviewer", () => {
  const context = { contractVersion: 1, roomId: "room", evaluatedThrough: 4,
    policy: { requireOwnerDecision: false, requireIndependentReview: true }, roster: [
      { id: "owner", kind: "human", active: true, permissions: ["decide", "verify"] },
      { id: "producer", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] }] };
  const brief = { requestId: "req-1", workItemId: "work-1", accountableMemberId: "producer",
    humanDecisionMakerId: "owner", verifierMemberId: "owner", offerId: "research-brief",
    outcome: "Compare options", acceptanceCriteria: ["Primary sources"], approvalPolicy: "human" };
  const prepared = prepareWorkOffer(brief, { context });
  assert.equal(prepared.approval.ownerDecisionRequired, false);
  assert.equal(prepared.approval.reviewerMemberId, "owner");
});
