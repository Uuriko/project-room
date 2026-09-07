import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES as T, applyEvent, event, replay, matchesReceipt as domainMatches } from "../src/events.js";
import { initialRoom } from "../server/bootstrap.mjs";
import { matchesReceipt, nextWorkStep, terminalWork, workStatus, workActions } from "../src/workflow.js";

function room(independentVerificationRequired, ownerDecisionRequired) {
  let state = replay(initialRoom());
  const send = (actorId, type, data = {}) => {
    state = applyEvent(state, event({ actorId, roomId: "commons", type, data }));
    return state;
  };
  send("owner", T.MEMBER_ADDED, { memberId: "producer", displayName: "Producer", kind: "agent", accountableHumanId: "owner", permissions: ["accept_work", "complete_work"] });
  send("owner", T.MEMBER_ADDED, { memberId: "reviewer", displayName: "Reviewer", kind: "agent", accountableHumanId: "owner", permissions: ["verify"] });
  send("owner", T.WORK_PROPOSED, { workItemId: "work", title: "Small finding", definitionOfDone: "Versioned evidence", accountableMemberId: "producer",
    independentVerificationRequired, ownerDecisionRequired, verifierMemberId: independentVerificationRequired ? "reviewer" : null, humanDecisionMakerId: ownerDecisionRequired ? "owner" : null });
  const item = () => state.workItems.work;
  const mutate = (actorId, type, data = {}) => send(actorId, type, { workItemId: "work", expectedRevision: item().revision, ...data });
  const evidence = () => ({ completionEventId: item().receipt.eventId, evidenceVersion: item().receipt.evidenceVersion });
  return { item, mutate, evidence, member: id => state.members[id] };
}

for (const review of [false, true]) for (const decision of [false, true]) {
  test(`required checks remain independent: review=${review}, decision=${decision}`, () => {
    const f = room(review, decision);
    const next = action => assert.equal(nextWorkStep(f.item()).action, action);
    next("accept");
    f.mutate("producer", T.WORK_ACCEPTED);
    next("start");
    assert.throws(() => f.mutate("producer", T.WORK_COMPLETED, { summary: "Not enough evidence" }), /missing evidenceUrl/);
    f.mutate("producer", T.WORK_COMPLETED, { summary: "A useful finding", evidenceUrl: "https://example.invalid/finding", evidenceVersion: "v1", producerId: "producer", nextAction: "Use the finding" });
    next(review ? "verify" : decision ? "decide" : "complete");
    assert.equal(terminalWork(f.item()), !review && !decision);
    if (review) {
      assert.equal(workStatus(f.item()).tone, "pending");
      if (decision) assert.throws(() => f.mutate("owner", T.OWNER_DECISION_RECORDED, { ...f.evidence(), decision: "approved", reason: "Too early" }), /independent PASS/);
      f.mutate("reviewer", T.VERIFICATION_RECORDED, { ...f.evidence(), result: "pass", summary: "Checked this version" });
      next(decision ? "decide" : "complete");
    }
    if (decision) {
      assert.equal(workStatus(f.item()).tone, "pending");
      f.mutate("owner", T.OWNER_DECISION_RECORDED, { ...f.evidence(), decision: "approved", reason: "Accept the finding" });
    }
    next("complete");
    assert.equal(terminalWork(f.item()), true);
    assert.equal(workStatus(f.item()).tone, "completed");
    assert.equal(f.item().mode, "read");
  });
}

test("reviewing again can record a finding after approval without losing the prior checks", () => {
  const f = room(true, true);
  f.mutate("producer", T.WORK_ACCEPTED);
  f.mutate("producer", T.WORK_COMPLETED, { summary: "Draft", evidenceUrl: "https://example.invalid/draft", evidenceVersion: "v1", producerId: "producer", nextAction: "Review" });
  f.mutate("reviewer", T.VERIFICATION_RECORDED, { ...f.evidence(), result: "pass", summary: "First check" });
  f.mutate("owner", T.OWNER_DECISION_RECORDED, { ...f.evidence(), decision: "approved", reason: "Accepted" });
  assert.deepEqual(workActions(f.item(), f.member("reviewer")), [["verify", "Review evidence again"]]);
  f.mutate("reviewer", T.VERIFICATION_RECORDED, { ...f.evidence(), result: "fail", summary: "Found an error", nextAction: "Correct the citation" });
  assert.equal(terminalWork(f.item()), false);
  assert.equal(workStatus(f.item()).next, "Correct the citation");
  assert.equal(workStatus(f.item()).tone, "blocked");
  assert.equal(f.item().decision, null);
  assert.equal(f.item().decisionHistory.at(-1).invalidatedReason, "verification_failed");
  assert.equal(f.item().verificationHistory.at(-1).result, "pass");
  assert.deepEqual(workActions(f.item(), f.member("producer")), [["resolve", "Resolve blocker"]]);
});

test("visible actions respect roles, producer independence, claims and retired work", () => {
  const f = room(true, true), member = f.member("producer");
  const actions = (item, actor = member) => workActions(item, actor, 1000).map(([action]) => action);
  const item = { ...f.item(), state: "accepted", mode: "write" };
  assert.deepEqual(actions(item), ["block"]);
  const writer = { ...member, permissions: [...member.permissions, "write_external"] };
  assert.deepEqual(actions(item, writer), ["claim", "block"]);
  item.claim = { status: "active", holderId: "producer", expiresAt: new Date(2000).toISOString() };
  assert.deepEqual(actions(item, writer), ["start", "block", "complete"]);
  item.claim.holderId = "other";
  assert.deepEqual(actions(item, writer), ["block"]);
  item.claim.expiresAt = new Date(1000).toISOString();
  assert.deepEqual(actions(item, writer), ["claim", "block"]);
  assert.deepEqual(actions(item, { ...writer, active: false }), []);
  assert.deepEqual(actions({ ...item, supersededBy: "replacement" }, writer), []);
  const completed = { ...f.item(), state: "completed", receipt: { eventId: "receipt", evidenceVersion: "v1", producerId: "reviewer", producerAttribution: "reported" } };
  assert.deepEqual(actions(completed, f.member("reviewer")), []);
  completed.receipt.producerId = null;
  assert.deepEqual(actions(completed, f.member("reviewer")), ["verify"]);
  assert.deepEqual(actions(completed, f.member("owner")), []);
});

test("domain and presentation use the same exact-receipt matcher", () => {
  assert.equal(matchesReceipt, domainMatches);
  for (const receipt of [null, {}, { eventId: "r" }, { evidenceVersion: "v" }]) assert.equal(matchesReceipt({}, receipt), false);
  assert.equal(matchesReceipt({ completionEventId: "r", evidenceVersion: "v" }, { eventId: "r", evidenceVersion: "v" }), true);
  assert.equal(matchesReceipt({ completionEventId: "r", evidenceVersion: "old" }, { eventId: "r", evidenceVersion: "v" }), false);
});
