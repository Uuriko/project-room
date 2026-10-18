// K007 + dispute-resolution slice 2: dispute state machine tests.
// R-1 (#3726 rider): the appeal/withdraw rungs were removed as unreachable —
// the tests that pinned them are replaced by a surface-absence pin below.
import test from "node:test";
import assert from "node:assert/strict";
import { createDisputes, DisputeError } from "../server/bounty-disputes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DisputeError && error.code === code);
const ECON = { bountyId: "b1", bountyAmount: 1000, raisedBy: "alice", reason: "work not delivered" };
const BOND = 50; // the machine floor, max($1, 5% of 1000): these tests drive the
// machine directly. Production bonds are exactly 25%, enforced by
// BountyEscrow.disputeBounty (#3307).

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

test("R-1: the appeal/withdraw rungs are gone from the machine surface", () => {
  const disputes = createDisputes();
  // Removed in the #3726 rider: no production consumer ever called them
  // (the escrow drives open/challenge/evidence/seat/decide/finalize only).
  assert.equal(disputes.appeal, undefined);
  assert.equal(disputes.escalate, undefined);
  assert.equal(disputes.withdraw, undefined);
  assert.equal(disputes.requiredAppealBond, undefined);
  assert.ok(!disputes.STATES.includes("appealed"));
  assert.ok(!disputes.STATES.includes("withdrawn"));
});

test("frivolous ruling forfeits the bond", () => {
  const disputes = createDisputes();
  const decided = toDecided(disputes, "d1", "frivolous", ["frivolous"]);
  assert.equal(decided.forfeitedBond, BOND);
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

test("dispute cost is capped at 25% of the bounty across the whole dispute", () => {
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

const runLadder = disputes => {
  disputes.open({ disputeId: "d", bountyId: "bounty-1", bountyAmount: 1000,
    raisedBy: "alice", reason: "work missing", bond: 50 });
  disputes.challenge("d", { by: "bob" });
  disputes.submitEvidence("d", { by: "alice", summary: "screenshots" });
  disputes.seatDecider("d", { decider: "tier1" });
  disputes.decide("d", { outcome: "upheld", reasonCodes: ["receipt-incomplete"] });
};

test("finalize fires the single onDisputeFinalized callback once", () => {
  const packets = [];
  const disputes = createDisputes({ onDisputeFinalized: p => packets.push(p) });
  runLadder(disputes);
  const final = disputes.finalize("d");
  assert.equal(final.state, "resolved");
  assert.equal(packets.length, 1);
  const [packet] = packets;
  assert.equal(packet.disputeId, "d");
  assert.equal(packet.bountyId, "bounty-1");
  assert.equal(packet.terminal, "resolved");
  assert.equal(packet.outcome, "upheld");
  assert.deepEqual([...packet.reasonCodes], ["receipt-incomplete"]);
  assert.equal(packet.tier, 0);
  assert.equal(packet.kind, "economic");
  assert.ok(Object.isFrozen(packet));
  // A second finalize is an illegal transition, so the callback cannot double-fire.
  throwsCode(() => disputes.finalize("d"), "invalid_transition");
  assert.equal(packets.length, 1);
});

test("a throwing escrow handler still leaves the dispute terminal", () => {
  const disputes = createDisputes({ onDisputeFinalized: () => { throw new Error("escrow down"); } });
  runLadder(disputes);
  assert.throws(() => disputes.finalize("d"), /escrow down/);
  assert.equal(disputes.get("d").state, "resolved"); // machine never gets stuck
  throwsCode(() => disputes.finalize("d"), "invalid_transition"); // still no double-fire
});

test("no handler configured is fine; non-function handler is refused", () => {
  const disputes = createDisputes();
  runLadder(disputes);
  assert.equal(disputes.finalize("d").state, "resolved");
  assert.throws(() => createDisputes({ onDisputeFinalized: "nope" }),
    error => error instanceof DisputeError && /must be a function/.test(error.message));
});
