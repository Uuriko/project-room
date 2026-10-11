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

test("done chip marks already-rendered chips so the pop doesn't replay (motion-loop audit)", () => {
  const done = { id: "w1", state: "completed", ownerDecisionRequired: false,
    receipt: { eventId: "e1", evidenceVersion: 1 }, verification: null,
    independentVerificationRequired: false };
  // First render: no marker — the one-shot pop celebrates the transition.
  const first = doneChip(done);
  assert.doesNotMatch(first, /done-chip-seen/);
  // Repeat render (the people rail rebuilds every 30s presence poll): the
  // marker tells CSS to skip the pop — motion only for a state change.
  const repeat = doneChip(done, { seen: true });
  assert.match(repeat, /class="done-chip done-chip-seen"/);
  // Default call stays byte-identical to the pre-fix markup.
  assert.equal(doneChip(done), first);
});
