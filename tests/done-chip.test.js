import test from "node:test";
import assert from "node:assert/strict";
import { doneChip, terminalWork } from "../src/workflow.js";

test("done chip renders only for terminally finished work (round-2 #117)", () => {
  const done = { state: "completed", ownerDecisionRequired: false,
    receipt: { eventId: "e1", evidenceVersion: 1 }, verification: null,
    independentVerificationRequired: false };
  assert.ok(terminalWork(done));
  const chip = doneChip(done);
  assert.match(chip, /done-chip/);
  assert.match(chip, /✓ Done/);

  assert.equal(doneChip({ state: "working" }), "");
  assert.equal(doneChip({ state: "completed" }), ""); // no receipt: not terminal
  assert.equal(doneChip({ state: "superseded" }), ""); // superseded isn't "done"
});
