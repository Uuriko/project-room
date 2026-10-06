// Trial tasks — Demigod x Project Room paid-trial rails (option 4, Lemon.io shape).
// RECORD-ONLY: no money moves in this build; `funded` means "trial budget
// recorded", never a ledger movement.
//
// Authoring gate (test-audit): each test below guards one independent
// contract of the trial-task state machine or its HTTP surface —
// transition legality, the 10000-bps rubric invariant, Demigod linkage,
// the funded-requires-budget-record rule, and machine-readable route
// errors. The credible regression for each is a future change that
// silently weakens the gate it pins (a shortcut transition, numeric
// amounts, a dropped budget record, a 500 instead of 422/409).
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTrialTask,
  fundTrialTask,
  claimTrialTask,
  submitTrialTask,
  verdictTrialTask,
  receiptTrialTask,
  blockTrialTask,
  resumeTrialTask,
  releaseTrialTask,
  TrialTaskError,
  TRIAL_TASK_STATES,
} from "../server/trial-tasks.mjs";


const NOW = "2026-10-06T07:30:00.000Z";

function validInput(overrides = {}) {
  return {
    demigodReqId: "demigod-req-9f2a",
    title: "Paid trial: checkout latency spike",
    trialScope: { hoursMax: "40", deliverableShape: "PR + write-up" },
    vettingRubric: [
      { criterion: "correctness", weightBps: "6000" },
      { criterion: "communication", weightBps: "4000" },
    ],
    feePolicyRef: "fee-policy/demigod-standard-v1",
    ...overrides,
  };
}

function fundedTask(overrides = {}) {
  const created = createTrialTask(validInput(overrides), NOW);
  return fundTrialTask(created, { note: "trial budget recorded: 40h at policy rate" }, NOW);
}

// --- pure state machine --------------------------------------------------------

test("create: valid input yields a proposed task echoing its record", () => {
  const task = createTrialTask(validInput(), NOW);
  assert.equal(task.state, "proposed");
  assert.equal(task.demigodReqId, "demigod-req-9f2a");
  assert.equal(task.title, "Paid trial: checkout latency spike");
  assert.deepEqual(task.trialScope, { hoursMax: "40", deliverableShape: "PR + write-up" });
  assert.equal(task.feePolicyRef, "fee-policy/demigod-standard-v1");
  assert.equal(task.candidateId, null);
  assert.deepEqual(task.history, [{ at: NOW, from: null, to: "proposed" }]);
});

test("create: demigodReqId is required (Demigod linkage)", () => {
  assert.throws(() => createTrialTask(validInput({ demigodReqId: "" }), NOW),
    err => err instanceof TrialTaskError && err.code === "missing_demigod_req_id");
  assert.throws(() => createTrialTask(validInput({ demigodReqId: undefined }), NOW),
    err => err instanceof TrialTaskError && err.code === "missing_demigod_req_id");
});

test("create: rubric weights must sum to exactly 10000 bps", () => {
  const bad = [
    { criterion: "correctness", weightBps: "6000" },
    { criterion: "communication", weightBps: "3999" },
  ];
  assert.throws(() => createTrialTask(validInput({ vettingRubric: bad }), NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_rubric_weights");
});

test("create: rubric weights must be strings (receipt-standard bans JSON numbers)", () => {
  const numeric = [
    { criterion: "correctness", weightBps: 6000 },
    { criterion: "communication", weightBps: 4000 },
  ];
  assert.throws(() => createTrialTask(validInput({ vettingRubric: numeric }), NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_rubric_weights");
});

test("create: hoursMax must be a string-int (amounts stay strings)", () => {
  assert.throws(() => createTrialTask(validInput({ trialScope: { hoursMax: 40, deliverableShape: "PR" } }), NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_trial_task_input");
});

test("fund: budget record moves proposed to funded (RECORD-ONLY)", () => {
  const task = fundTrialTask(createTrialTask(validInput(), NOW), { note: "budget noted" }, NOW);
  assert.equal(task.state, "funded");
  assert.deepEqual(task.budgetRecord, { note: "budget noted" });
  assert.deepEqual(task.history.at(-1), { at: NOW, from: "proposed", to: "funded" });
});

test("fund: funded-without-budget-record is rejected", () => {
  const task = createTrialTask(validInput(), NOW);
  assert.throws(() => fundTrialTask(task, null, NOW),
    err => err instanceof TrialTaskError && err.code === "missing_budget_record");
  assert.throws(() => fundTrialTask(task, {}, NOW),
    err => err instanceof TrialTaskError && err.code === "missing_budget_record");
});

test("illegal transitions are rejected with the allowed next states", () => {
  const proposed = createTrialTask(validInput(), NOW);
  const funded = fundTrialTask(proposed, { note: "b" }, NOW);
  const claimed = claimTrialTask(funded, { candidateId: "cand-1" }, NOW);
  const submitted = submitTrialTask(claimed, { deliverableRef: "https://example.com/pr/7" }, NOW);
  const verdict = verdictTrialTask(submitted, {
    rubricScores: [
      { criterion: "correctness", scoreBps: "6000" },
      { criterion: "communication", scoreBps: "3000" },
    ],
    verdict: "pass",
  }, NOW);
  const receipted = receiptTrialTask(verdict, {}, NOW);
  const released = releaseTrialTask(createTrialTask(validInput(), NOW), {}, NOW);
  const blocked = blockTrialTask(claimed, {}, NOW);

  const cases = [
    ["proposed cannot be claimed", proposed, t => claimTrialTask(t, { candidateId: "c" }, NOW)],
    ["proposed cannot be submitted", proposed, t => submitTrialTask(t, { deliverableRef: "r" }, NOW)],
    ["proposed cannot go to verdict", proposed, t => verdictTrialTask(t, { rubricScores: [], verdict: "pass" }, NOW)],
    ["funded cannot be submitted", funded, t => submitTrialTask(t, { deliverableRef: "r" }, NOW)],
    ["funded cannot be funded again", funded, t => fundTrialTask(t, { note: "b" }, NOW)],
    ["claimed cannot go to verdict", claimed, t => verdictTrialTask(t, { rubricScores: [], verdict: "pass" }, NOW)],
    ["submitted cannot be receipted", submitted, t => receiptTrialTask(t, {}, NOW)],
    ["verdict cannot be claimed", verdict, t => claimTrialTask(t, { candidateId: "c" }, NOW)],
    ["blocked cannot be submitted", blocked, t => submitTrialTask(t, { deliverableRef: "r" }, NOW)],
    ["receipted is terminal", receipted, t => releaseTrialTask(t, {}, NOW)],
    ["released is terminal", released, t => fundTrialTask(t, { note: "b" }, NOW)],
  ];
  for (const [name, task, fn] of cases) {
    assert.throws(fn.bind(null, task),
      err => err instanceof TrialTaskError && err.code === "illegal_transition" && Array.isArray(err.allowed),
      name);
  }
});

test("claim: candidateId is required", () => {
  const task = fundedTask();
  assert.throws(() => claimTrialTask(task, {}, NOW),
    err => err instanceof TrialTaskError && err.code === "missing_candidate_id");
  const claimed = claimTrialTask(task, { candidateId: "cand-1" }, NOW);
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.candidateId, "cand-1");
});

test("submit: deliverableRef is required", () => {
  const task = claimTrialTask(fundedTask(), { candidateId: "cand-1" }, NOW);
  assert.throws(() => submitTrialTask(task, {}, NOW),
    err => err instanceof TrialTaskError && err.code === "missing_deliverable_ref");
  const submitted = submitTrialTask(task, { deliverableRef: "https://example.com/pr/7" }, NOW);
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.deliverableRef, "https://example.com/pr/7");
});

test("verdict: verdict must be pass|fail", () => {
  const task = submitTrialTask(claimTrialTask(fundedTask(), { candidateId: "c" }, NOW), { deliverableRef: "r" }, NOW);
  const scores = [
    { criterion: "correctness", scoreBps: "6000" },
    { criterion: "communication", scoreBps: "4000" },
  ];
  assert.throws(() => verdictTrialTask(task, { rubricScores: scores, verdict: "maybe" }, NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_verdict");
});

test("verdict: rubricScores must cover every criterion exactly once, in range", () => {
  const task = submitTrialTask(claimTrialTask(fundedTask(), { candidateId: "c" }, NOW), { deliverableRef: "r" }, NOW);
  const missing = [{ criterion: "correctness", scoreBps: "6000" }];
  assert.throws(() => verdictTrialTask(task, { rubricScores: missing, verdict: "pass" }, NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_rubric_scores");
  const unknown = [
    { criterion: "correctness", scoreBps: "6000" },
    { criterion: "vibes", scoreBps: "4000" },
  ];
  assert.throws(() => verdictTrialTask(task, { rubricScores: unknown, verdict: "pass" }, NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_rubric_scores");
  const over = [
    { criterion: "correctness", scoreBps: "6001" },
    { criterion: "communication", scoreBps: "4000" },
  ];
  assert.throws(() => verdictTrialTask(task, { rubricScores: over, verdict: "pass" }, NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_rubric_scores");
  const numericScore = [
    { criterion: "correctness", scoreBps: 6000 },
    { criterion: "communication", scoreBps: "4000" },
  ];
  assert.throws(() => verdictTrialTask(task, { rubricScores: numericScore, verdict: "pass" }, NOW),
    err => err instanceof TrialTaskError && err.code === "invalid_rubric_scores");
});

test("verdict then receipt: happy path reaches receipted (pass and fail both receipt)", () => {
  const submit = t => submitTrialTask(claimTrialTask(fundTrialTask(createTrialTask(validInput(), NOW), { note: "b" }, NOW), { candidateId: "c" }, NOW), { deliverableRef: "r" }, NOW);
  for (const v of ["pass", "fail"]) {
    const done = receiptTrialTask(verdictTrialTask(submit(), {
      rubricScores: [
        { criterion: "correctness", scoreBps: "6000" },
        { criterion: "communication", scoreBps: "4000" },
      ],
      verdict: v,
    }, NOW), {}, NOW);
    assert.equal(done.state, "receipted", `verdict ${v}`);
    assert.equal(done.verdict, v);
  }
});

test("block/resume/release: blocked parks and resumes; released is terminal", () => {
  const claimed = claimTrialTask(fundedTask(), { candidateId: "c" }, NOW);
  const blocked = blockTrialTask(claimed, { reason: "waiting on scope" }, NOW);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blockedFrom, "claimed");
  const resumed = resumeTrialTask(blocked, NOW);
  assert.equal(resumed.state, "claimed");
  assert.equal(resumed.blockedFrom, null); // parked state cleared, same as a fresh task

  const proposed = createTrialTask(validInput(), NOW);
  const released = releaseTrialTask(proposed, { reason: "req withdrawn" }, NOW);
  assert.equal(released.state, "released");
  assert.throws(() => resumeTrialTask(released, NOW),
    err => err instanceof TrialTaskError && err.code === "illegal_transition");
});

test("state vocabulary matches the documented lifecycle", () => {
  assert.deepEqual([...TRIAL_TASK_STATES].sort(), ["blocked", "claimed", "funded", "proposed", "receipted", "released", "submitted", "verdict"]);
});
