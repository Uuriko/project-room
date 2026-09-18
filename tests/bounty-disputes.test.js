// K007 + dispute-resolution slice 2: escalation-ladder state machine tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createDisputes, DisputeError } from "../server/bounty-disputes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DisputeError && error.code === code);
const ECON = { bountyId: "b1", bountyAmount: 1000, raisedBy: "alice", reason: "work not delivered" };
const BOND = 50; // max($1, 5% of 1000)

// Drives a dispute to decided.
function toDecided(disputes, id = "d1", outcome = "upheld", codes = ["receipt-incomplete"]) {
  disputes.open({ disputeId: id, ...ECON, bond: BOND });
  disputes.challenge(id, { by: "alice" });
  disputes.submitEvidence(id, { by: "bob", summary: "here is the PR" });
  disputes.seatDecider(id, { decider: "verifier:carol" });
  return disputes.decide(id, { outcome, reasonCodes: codes });
}

test("full ladder: opened → challenged → evidence → adjudicating → decided → resolved", () => {
  const disputes = createDisputes();
  const opened = disputes.open({ disputeId: "d1", ...ECON, bond: BOND });
  assert.equal(opened.state, "opened");
  assert.equal(opened.maxDisputeCost, 250); // 25% of 1000
  assert.equal(opened.bondSnapshot, BOND);
  assert.equal(opened.tier, 0);
  assert.equal(disputes.challenge("d1", { by: "alice" }).state, "challenged");
  const withEvidence = disputes.submitEvidence("d1", { by: "bob", summary: "here is the PR" });
  assert.equal(withEvidence.state, "evidence");
  assert.equal(withEvidence.evidence.length, 1);
  assert.equal(disputes.seatDecider("d1", { decider: "verifier:carol" }).state, "adjudicating");
  const decided = disputes.decide("d1", { outcome: "upheld", reasonCodes: ["receipt-incomplete"] });
  assert.equal(decided.state, "decided");
  assert.deepEqual(decided.resolution.reasonCodes, ["receipt-incomplete"]);
  const resolved = disputes.finalize("d1");
  assert.equal(resolved.state, "resolved");
  assert.ok(Object.isFrozen(opened) && Object.isFrozen(resolved));
});

test("economic open requires a bond (bond-missing)", () => {
  const disputes = createDisputes();
  throwsCode(() => disputes.open({ disputeId: "d", ...ECON }), "bond-missing");
  throwsCode(() => disputes.open({ disputeId: "d", ...ECON, bond: 10 }), "invalid_dispute"); // below 5%
  throwsCode(() => disputes.open({ disputeId: "d", ...ECON, kind: "coordination", bond: 10 }), "invalid_dispute");
  const coord = disputes.open({ disputeId: "c", ...ECON, kind: "coordination" });
  assert.equal(coord.bondSnapshot, "none");
  assert.equal(coord.state, "opened");
});

test("appeal doubles the bond per tier and returns to adjudicating", () => {
  const disputes = createDisputes();
  toDecided(disputes);
  throwsCode(() => disputes.appeal("d1", { by: "dave" }), "bond-missing"); // no bond posted
  throwsCode(() => disputes.appeal("d1", { by: "dave", bond: 99 }), "invalid_dispute"); // below 2x
  const appealed = disputes.appeal("d1", { by: "dave", bond: 100 }); // 2x tier-0 bond
  assert.equal(appealed.state, "appealed");
  assert.equal(appealed.escalations.length, 1);
  assert.equal(appealed.escalations[0].tier, 1);
  assert.equal(disputes.escalate("d1", { decider: "steward-panel" }).tier, 1);
  // second appeal requires 2x the tier-1 bond (4x the open bond)
  disputes.decide("d1", { outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  throwsCode(() => disputes.appeal("d1", { by: "alice", bond: 199 }), "invalid_dispute");
  const appealed2 = disputes.appeal("d1", { by: "alice", bond: 200 });
  assert.equal(appealed2.escalations.length, 2);
  assert.equal(appealed2.escalations[1].decision, undefined);
});

test("frivolous ruling forfeits the bond and has no appeal as of right", () => {
  const disputes = createDisputes();
  const decided = toDecided(disputes, "d1", "frivolous", ["frivolous"]);
  assert.equal(decided.forfeitedBond, BOND);
  throwsCode(() => disputes.appeal("d1", { by: "alice", bond: 100 }), "frivolous");
  throwsCode(() => disputes.escalate("d1", { decider: "x" }), "invalid_transition");
});

test("withdraw forfeits the bond from any non-terminal state", () => {
  const disputes = createDisputes();
  disputes.open({ disputeId: "d1", ...ECON, bond: BOND });
  const w1 = disputes.withdraw("d1", { by: "alice" });
  assert.equal(w1.state, "withdrawn");
  assert.equal(w1.forfeitedBond, BOND);
  disputes.open({ disputeId: "d2", ...ECON, bond: BOND });
  disputes.challenge("d2", { by: "alice" });
  disputes.submitEvidence("d2", { by: "bob", summary: "s" });
  const w2 = disputes.withdraw("d2", { by: "alice" });
  assert.equal(w2.state, "withdrawn");
  assert.equal(w2.forfeitedBond, BOND);
  throwsCode(() => disputes.withdraw("d2"), "invalid_transition");
});

test("illegal transitions are rejected with invalid_transition", () => {
  const disputes = createDisputes();
  disputes.open({ disputeId: "d1", ...ECON, bond: BOND });
  throwsCode(() => disputes.submitEvidence("d1", { by: "b", summary: "s" }), "invalid_transition");
  throwsCode(() => disputes.seatDecider("d1", { decider: "x" }), "invalid_transition");
  throwsCode(() => disputes.decide("d1", { outcome: "upheld", reasonCodes: ["frivolous"] }), "invalid_transition");
  throwsCode(() => disputes.finalize("d1"), "invalid_transition");
  disputes.challenge("d1", { by: "alice" });
  throwsCode(() => disputes.challenge("d1", { by: "alice" }), "invalid_transition");
  throwsCode(() => disputes.finalize("d1"), "invalid_transition");
});

test("dispute cost is capped at 25% of the bounty across the whole escalation", () => {
  const disputes = createDisputes();
  disputes.open({ disputeId: "d2", bountyId: "b2", bountyAmount: 400, raisedBy: "a", reason: "x", bond: 20 });
  disputes.challenge("d2", { by: "a" });
  const after = disputes.recordCost("d2", 100); // exactly the cap
  assert.equal(after.recordedCost, 100);
  throwsCode(() => disputes.recordCost("d2", 1), "dispute_cost_capped");
  disputes.submitEvidence("d2", { by: "a", summary: "s" });
  disputes.seatDecider("d2", { decider: "v" });
  disputes.decide("d2", { outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  throwsCode(() => disputes.recordCost("d2", 1), "invalid_transition"); // decided: costs frozen
  disputes.appeal("d2", { by: "a", bond: 40 });
  disputes.escalate("d2", { decider: "panel" });
  throwsCode(() => disputes.recordCost("d2", 1), "dispute_cost_capped"); // cap spans tiers
});

test("unavailable is an overlay, not a state", () => {
  const disputes = createDisputes();
  disputes.open({ disputeId: "d1", ...ECON, bond: BOND });
  const flagged = disputes.markUnavailable("d1", "no-arbitrator");
  assert.equal(flagged.state, "opened");
  assert.equal(flagged.unavailable, "no-arbitrator");
  disputes.challenge("d1", { by: "alice" });
  assert.equal(disputes.get("d1").unavailable, "no-arbitrator");
  assert.equal(disputes.clearUnavailable("d1").unavailable, null);
});

test("reason codes come from the fixed vocabulary", () => {
  const disputes = createDisputes();
  disputes.open({ disputeId: "d1", ...ECON, bond: BOND });
  disputes.challenge("d1", { by: "alice" });
  disputes.submitEvidence("d1", { by: "b", summary: "s" });
  disputes.seatDecider("d1", { decider: "v" });
  throwsCode(() => disputes.decide("d1", { outcome: "upheld", reasonCodes: ["made-up"] }), "invalid_dispute");
  throwsCode(() => disputes.decide("d1", { outcome: "upheld", reasonCodes: [] }), "invalid_dispute");
  throwsCode(() => disputes.decide("d1", { outcome: "maybe", reasonCodes: ["frivolous"] }), "invalid_dispute");
});

test("malformed inputs are refused", () => {
  const disputes = createDisputes();
  throwsCode(() => disputes.open({ disputeId: "d", bountyId: "b", bountyAmount: 0, raisedBy: "a", reason: "x", bond: 1 }),
    "invalid_dispute");
  throwsCode(() => disputes.finalize("ghost"), "invalid_dispute");
  throwsCode(() => disputes.get("ghost"), "invalid_dispute");
});
