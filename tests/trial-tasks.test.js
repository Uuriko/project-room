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
  createTrialTaskRegistry,
  TrialTaskError,
  TRIAL_TASK_STATES,
} from "../server/trial-tasks.mjs";
import { handleTrialTasks } from "../server/trial-tasks-routes.mjs";

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

// --- HTTP routes ---------------------------------------------------------------

function fakeCall({ method, path, data, registry, identity = { id: "agent-1", displayName: "Agent" } }) {
  const chunks = [];
  const req = { method, url: path };
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(bytes) { chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes))); },
  };
  const url = new URL(path, "http://localhost");
  const body = async () => data;
  return handleTrialTasks({ req, res, url, body, identity, registry }).then(handled => ({
    handled,
    status: res.statusCode,
    json: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
  }));
}

test("routes: POST /api/trial-tasks creates (201); budgetRecord funds directly", async () => {
  const registry = createTrialTaskRegistry();
  const created = await fakeCall({ method: "POST", path: "/api/trial-tasks", data: validInput(), registry });
  assert.equal(created.handled, true);
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "ok");
  assert.equal(created.json.task.state, "proposed");

  const funded = await fakeCall({
    method: "POST", path: "/api/trial-tasks",
    data: { ...validInput(), budgetRecord: { note: "budget recorded" } }, registry,
  });
  assert.equal(funded.status, 201);
  assert.equal(funded.json.task.state, "funded");
});

test("routes: POST /api/trial-tasks validates input (422, machine-readable)", async () => {
  const registry = createTrialTaskRegistry();
  const res = await fakeCall({ method: "POST", path: "/api/trial-tasks", data: validInput({ demigodReqId: "" }), registry });
  assert.equal(res.status, 422);
  assert.equal(res.json.status, "error");
  assert.equal(res.json.code, "missing_demigod_req_id");
  assert.ok(typeof res.json.hint === "string" && res.json.hint.length > 0);
  assert.ok(Array.isArray(res.json.next) && res.json.next.length > 0);
});

test("routes: writes require an identity (401)", async () => {
  const registry = createTrialTaskRegistry();
  const res = await fakeCall({ method: "POST", path: "/api/trial-tasks", data: validInput(), registry, identity: null });
  assert.equal(res.status, 401);
  assert.equal(res.json.code, "identity_required");
});

test("routes: GET /api/trial-tasks/:id reads; unknown id is 404", async () => {
  const registry = createTrialTaskRegistry();
  const created = await fakeCall({ method: "POST", path: "/api/trial-tasks", data: validInput(), registry });
  const id = created.json.task.id;
  const got = await fakeCall({ method: "GET", path: `/api/trial-tasks/${id}`, registry, identity: null });
  assert.equal(got.status, 200);
  assert.equal(got.json.task.id, id);
  const missing = await fakeCall({ method: "GET", path: "/api/trial-tasks/nope", registry, identity: null });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "trial_task_not_found");
});

test("routes: full lifecycle through the verbs", async () => {
  const registry = createTrialTaskRegistry();
  const created = await fakeCall({
    method: "POST", path: "/api/trial-tasks",
    data: { ...validInput(), budgetRecord: { note: "budget recorded" } }, registry,
  });
  const id = created.json.task.id;

  const claim = await fakeCall({ method: "POST", path: `/api/trial-tasks/${id}/claim`, data: { candidateId: "cand-9" }, registry });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.task.state, "claimed");

  const funded2 = await fakeCall({
    method: "POST", path: "/api/trial-tasks",
    data: { ...validInput(), budgetRecord: { note: "budget recorded" } }, registry,
  });
  const claimMissing = await fakeCall({ method: "POST", path: `/api/trial-tasks/${funded2.json.task.id}/claim`, data: {}, registry });
  assert.equal(claimMissing.status, 422);
  assert.equal(claimMissing.json.code, "missing_candidate_id");

  const submit = await fakeCall({ method: "POST", path: `/api/trial-tasks/${id}/submit`, data: { deliverableRef: "https://example.com/pr/9" }, registry });
  assert.equal(submit.status, 200);
  assert.equal(submit.json.task.state, "submitted");

  const verdict = await fakeCall({
    method: "POST", path: `/api/trial-tasks/${id}/verdict`, registry,
    data: {
      rubricScores: [
        { criterion: "correctness", scoreBps: "5500" },
        { criterion: "communication", scoreBps: "4000" },
      ],
      verdict: "pass",
    },
  });
  assert.equal(verdict.status, 200);
  assert.equal(verdict.json.task.state, "verdict");
  assert.equal(verdict.json.task.verdict, "pass");
});

test("routes: illegal transitions surface as 409 with allowed next states", async () => {
  const registry = createTrialTaskRegistry();
  const created = await fakeCall({ method: "POST", path: "/api/trial-tasks", data: validInput(), registry });
  const id = created.json.task.id;
  const res = await fakeCall({ method: "POST", path: `/api/trial-tasks/${id}/submit`, data: { deliverableRef: "r" }, registry });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, "illegal_transition");
  assert.ok(Array.isArray(res.json.allowed));
});

test("routes: verdict rejects bad verdict values (422)", async () => {
  const registry = createTrialTaskRegistry();
  const created = await fakeCall({
    method: "POST", path: "/api/trial-tasks",
    data: { ...validInput(), budgetRecord: { note: "b" } }, registry,
  });
  const id = created.json.task.id;
  await fakeCall({ method: "POST", path: `/api/trial-tasks/${id}/claim`, data: { candidateId: "c" }, registry });
  await fakeCall({ method: "POST", path: `/api/trial-tasks/${id}/submit`, data: { deliverableRef: "r" }, registry });
  const res = await fakeCall({
    method: "POST", path: `/api/trial-tasks/${id}/verdict`, registry,
    data: { rubricScores: [], verdict: "maybe" },
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.code, "invalid_verdict");
});

test("routes: unknown paths fall through (handled=false); wrong method is 405", async () => {
  const registry = createTrialTaskRegistry();
  const unknown = await fakeCall({ method: "GET", path: "/api/nope", registry, identity: null });
  assert.equal(unknown.handled, false);
  const wrongMethod = await fakeCall({ method: "DELETE", path: "/api/trial-tasks/abc", registry, identity: null });
  assert.equal(wrongMethod.handled, true);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.code, "method_not_allowed");
});
