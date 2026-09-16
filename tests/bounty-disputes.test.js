// K007: bounty dispute flow. Pure state-machine tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createDisputes, DisputeError } from "../server/bounty-disputes.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof DisputeError && error.code === code);

test("open → evidence → resolve lifecycle", () => {
  const disputes = createDisputes();
  const opened = disputes.open({ disputeId: "d1", bountyId: "b1", bountyAmount: 1000,
    raisedBy: "alice", reason: "work not delivered" });
  assert.equal(opened.state, "opened");
  assert.equal(opened.maxDisputeCost, 250); // 25% of 1000
  const withEvidence = disputes.submitEvidence("d1", { by: "bob", summary: "here is the PR" });
  assert.equal(withEvidence.state, "evidence");
  assert.equal(withEvidence.evidence.length, 1);
  const resolved = disputes.resolve("d1", { outcome: "upheld", note: "confirmed" });
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.resolution.outcome, "upheld");
  assert.ok(Object.isFrozen(opened) && Object.isFrozen(resolved));
});
test("dispute cost is capped at 25% of the bounty", () => {
  const disputes = createDisputes();
  disputes.open({ disputeId: "d2", bountyId: "b2", bountyAmount: 400, raisedBy: "a", reason: "x" });
  const after = disputes.recordCost("d2", 100); // exactly the cap
  assert.equal(after.recordedCost, 100);
  throwsCode(() => disputes.recordCost("d2", 1), "dispute_cost_capped");
});
test("malformed inputs are refused", () => {
  const disputes = createDisputes();
  throwsCode(() => disputes.open({ disputeId: "d", bountyId: "b", bountyAmount: 0, raisedBy: "a", reason: "x" }),
    "invalid_dispute");
  throwsCode(() => disputes.resolve("ghost", { outcome: "upheld" }), "invalid_dispute");
  disputes.open({ disputeId: "d3", bountyId: "b3", bountyAmount: 100, raisedBy: "a", reason: "x" });
  throwsCode(() => disputes.resolve("d3", { outcome: "maybe" }), "invalid_dispute");
});
