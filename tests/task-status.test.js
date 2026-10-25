import test from "node:test";
import assert from "node:assert/strict";
import { TASK_STATUSES, taskStatus, taskStatusFromClaim, taskStatusFromWork } from "../src/task-status.js";

const claims = [
  ["unclaimed", "open", undefined],
  ["claimed", "claimed", undefined],
  ["in_progress", "running", undefined],
  ["blocked", "blocked", undefined],
  ["delivered", "needs_you", undefined],
  ["done", "done", "completed"],
  ["closed", "done", "closed"],
];

test("every legacy claim state maps into the canonical set", () => {
  for (const [legacy, status, outcome] of claims) {
    const mapped = taskStatusFromClaim({ state: legacy });
    assert.equal(mapped.status, status);
    assert.equal(mapped.legacy, legacy);
    assert.equal(mapped.label.split(" ").length <= 2, true);
    assert.ok(TASK_STATUSES.includes(mapped.status));
    assert.equal(mapped.outcome, outcome);
    assert.equal(taskStatus({ state: legacy }).status, status);
  }
  assert.equal(taskStatusFromClaim({ state: "retired" }), null);
  assert.equal(taskStatusFromClaim({}), null);
});

test("work states map through the same status function", () => {
  const base = { id: "w1", revision: 1, accountableMemberId: "ada" };
  assert.equal(taskStatusFromWork({ ...base, state: "proposed" }).status, "needs_you");
  assert.equal(taskStatusFromWork({ ...base, state: "proposed" }).outcome, "accept");
  assert.equal(taskStatusFromWork({ ...base, state: "accepted" }).status, "claimed");
  assert.equal(taskStatusFromWork({ ...base, state: "working" }).status, "running");
  assert.equal(taskStatusFromWork({ ...base, state: "blocked" }).status, "blocked");
  assert.equal(taskStatusFromWork({ ...base, state: "superseded" }).outcome, "superseded");
  assert.equal(taskStatusFromWork({ ...base, state: "working", supersededBy: "w2" }).status, "done");
  assert.equal(taskStatusFromWork({ ...base, state: "working", handoff: { open: true } }).outcome, "handoff");
  const needsEvidence = taskStatusFromWork({ ...base, state: "completed" });
  assert.equal(needsEvidence.status, "needs_you");
  assert.equal(needsEvidence.outcome, "provide_evidence");
  const finished = taskStatusFromWork({
    ...base,
    state: "completed",
    independentVerificationRequired: false,
    ownerDecisionRequired: false,
    receipt: { eventId: "e1", evidenceVersion: 1, producerAttribution: "reported", producerId: "ada" },
  });
  assert.equal(finished.status, "done");
  assert.equal(finished.outcome, "completed");
  assert.equal(taskStatusFromWork({ ...base, state: "nope" }), null);
  assert.equal(taskStatus({ ...base, source: "work", state: "accepted" }).status, "claimed");
  assert.equal(taskStatus({ definitionOfDone: "Ship", state: "blocked" }).status, "blocked");
});
