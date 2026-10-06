// Trial tasks — Demigod x Project Room paid-trial rails (option 4, Lemon.io shape).
//
// RECORD-ONLY: no money moves in this build, ever. `funded` means "trial
// budget recorded" — a bookkeeping note that a budget exists, never a
// ledger movement, escrow, or payout. Every money-adjacent field is a
// record, not a transaction:
//   - budgetRecord: the recorded budget note (currency/amountBps are
//     descriptive strings; nothing is debited, held, or transferred).
//   - feePolicyRef: an opaque pointer to the fee policy (Lane D owns the
//     policy itself); this module never computes or applies a fee.
//   - vettingRubric weights and rubricScores: basis points as STRINGS
//     (the receipt-standard bans JSON numbers in signed bodies); scoring
//     only, no amounts move.
//
// Lifecycle: proposed -> funded -> claimed -> submitted -> verdict ->
// receipted, plus blocked (parks, resumable) and released (terminal).
// A failed verdict still receipts: receipted records the verdict, it does
// not pay anything.
//
// Pure, dependency-free, deterministic; frozen outputs. Persistence is a
// later slice (an in-memory registry factory is provided for the routes).
// Validation errors throw TrialTaskError (code, no HTTP status); the HTTP
// layer maps codes to statuses.

const BPS_TOTAL = 10000n;
const BPS_RE = /^(0|[1-9][0-9]*)$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const TRIAL_TASK_STATES = [
  "proposed", "funded", "claimed", "submitted", "verdict", "receipted", "blocked", "released",
];
const TERMINAL_STATES = new Set(["receipted", "released"]);

// allowed[state] = next states reachable by a direct transition.
// blocked resumes via resumeTrialTask (returns to blockedFrom); it is not a
// named edge here so illegal_transition errors can name real destinations.
const TRANSITIONS = {
  proposed: ["funded", "blocked", "released"],
  funded: ["claimed", "blocked", "released"],
  claimed: ["submitted", "blocked", "released"],
  submitted: ["verdict", "blocked", "released"],
  verdict: ["receipted", "released"],
  blocked: ["released"],
  receipted: [],
  released: [],
};

export class TrialTaskError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "TrialTaskError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const fail = (code, message, extra) => { throw new TrialTaskError(code, message, extra); };
const check = (cond, code, message, extra) => { if (!cond) fail(code, message, extra); };

const isNonEmptyString = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

// Receipt-standard: amounts are strings. A JSON number (or anything else)
// is refused outright — never coerced.
const bpsOf = (value, what) => {
  check(typeof value === "string" && BPS_RE.test(value), "invalid_rubric_weights",
    `${what} must be a string of digits (basis points; JSON numbers are refused).`);
  return BigInt(value);
};

const sumBps = entries => entries.reduce((acc, e) => acc + bpsOf(e.weightBps, `weightBps for "${e.criterion}"`), 0n);

function rubricOf(value) {
  check(Array.isArray(value) && value.length >= 1 && value.length <= 32, "invalid_rubric_weights",
    "vettingRubric must be a non-empty array of at most 32 criteria.");
  const seen = new Set();
  for (const entry of value) {
    check(entry && typeof entry === "object" && !Array.isArray(entry), "invalid_rubric_weights",
      "each rubric entry must be an object { criterion, weightBps }.");
    check(isNonEmptyString(entry.criterion, 128), "invalid_rubric_weights",
      "each rubric criterion must be a 1..128 character string.");
    check(!seen.has(entry.criterion), "invalid_rubric_weights",
      `duplicate rubric criterion "${entry.criterion}".`);
    seen.add(entry.criterion);
    bpsOf(entry.weightBps, `weightBps for "${entry.criterion}"`);
  }
  const total = sumBps(value);
  check(total === BPS_TOTAL, "invalid_rubric_weights",
    `rubric weights must sum to exactly 10000 bps; got ${total}.`);
  return Object.freeze(value.map(e => Object.freeze({ criterion: e.criterion, weightBps: e.weightBps })));
}

function trialScopeOf(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "invalid_trial_task_input",
    "trialScope must be an object { hoursMax, deliverableShape }.");
  check(typeof value.hoursMax === "string" && BPS_RE.test(value.hoursMax), "invalid_trial_task_input",
    "trialScope.hoursMax must be a string integer (e.g. \"40\").");
  check(isNonEmptyString(value.deliverableShape, 256), "invalid_trial_task_input",
    "trialScope.deliverableShape must be a 1..256 character string.");
  return Object.freeze({ hoursMax: value.hoursMax, deliverableShape: value.deliverableShape });
}

// RECORD-ONLY budget note: the record that a budget exists. Required fields
// are the note itself; currency/amountBps stay optional descriptive strings.
function budgetRecordOf(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "missing_budget_record",
    "funding a trial task requires a budgetRecord (RECORD-ONLY: the recorded budget note; no money moves).");
  check(isNonEmptyString(value.note, 1024), "missing_budget_record",
    "budgetRecord.note must be a non-empty string describing the recorded budget.");
  const record = { note: value.note };
  if (value.currency !== undefined) {
    check(isNonEmptyString(value.currency, 16), "invalid_trial_task_input",
      "budgetRecord.currency must be a 1..16 character string.");
    record.currency = value.currency;
  }
  if (value.amountBps !== undefined) {
    check(typeof value.amountBps === "string" && BPS_RE.test(value.amountBps), "invalid_trial_task_input",
      "budgetRecord.amountBps must be a string of digits (receipt-standard).");
    record.amountBps = value.amountBps;
  }
  if (value.recordedBy !== undefined) {
    check(isNonEmptyString(value.recordedBy, 128), "invalid_trial_task_input",
      "budgetRecord.recordedBy must be a 1..128 character string.");
    record.recordedBy = value.recordedBy;
  }
  return Object.freeze(record);
}

function rubricScoresOf(task, value) {
  check(Array.isArray(value) && value.length === task.vettingRubric.length, "invalid_rubric_scores",
    "rubricScores must score every vettingRubric criterion exactly once.");
  const weights = new Map(task.vettingRubric.map(e => [e.criterion, BigInt(e.weightBps)]));
  const seen = new Set();
  for (const entry of value) {
    check(entry && typeof entry === "object" && !Array.isArray(entry), "invalid_rubric_scores",
      "each rubric score must be an object { criterion, scoreBps }.");
    check(weights.has(entry.criterion), "invalid_rubric_scores",
      `unknown rubric criterion "${entry?.criterion}".`);
    check(!seen.has(entry.criterion), "invalid_rubric_scores",
      `duplicate score for criterion "${entry.criterion}".`);
    seen.add(entry.criterion);
    check(typeof entry.scoreBps === "string" && BPS_RE.test(entry.scoreBps), "invalid_rubric_scores",
      `scoreBps for "${entry.criterion}" must be a string of digits (JSON numbers are refused).`);
    const score = BigInt(entry.scoreBps);
    check(score >= 0n && score <= weights.get(entry.criterion), "invalid_rubric_scores",
      `scoreBps for "${entry.criterion}" must be between 0 and its weight ${weights.get(entry.criterion)}.`);
  }
  return Object.freeze(value.map(e => Object.freeze({ criterion: e.criterion, scoreBps: e.scoreBps })));
}

const stamp = (task, from, to, now, extra = {}) => Object.freeze({
  ...task,
  ...extra,
  state: to,
  history: Object.freeze([...task.history, { at: now, from, to }]),
});

const at = now => now ?? new Date().toISOString();

const requireState = (task, want) => {
  if (task.state !== want) {
    fail("illegal_transition",
      `cannot leave state "${task.state}" for "${want}".`,
      { from: task.state, to: want, allowed: [...TRANSITIONS[task.state]] });
  }
};

const newId = () => `trial-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-6)}`;

// --- transitions ---------------------------------------------------------------

export function createTrialTask(input = {}, now) {
  check(input && typeof input === "object" && !Array.isArray(input), "invalid_trial_task_input",
    "trial task input must be an object.");
  check(isNonEmptyString(input.demigodReqId, 256), "missing_demigod_req_id",
    "demigodReqId is required: the opaque Demigod requisition this trial records against.");
  check(isNonEmptyString(input.title, 256), "invalid_trial_task_input",
    "title must be a 1..256 character string.");
  check(isNonEmptyString(input.feePolicyRef, 256), "invalid_trial_task_input",
    "feePolicyRef is required: opaque pointer to the fee policy (recorded, never applied here).");
  const id = input.id ?? newId();
  check(ID_RE.test(id), "invalid_trial_task_input",
    "id must match [A-Za-z0-9_-]{1,128}.");
  let candidateId = null;
  if (input.candidateId !== undefined && input.candidateId !== null) {
    check(isNonEmptyString(input.candidateId, 128), "invalid_trial_task_input",
      "candidateId must be a 1..128 character string.");
    candidateId = input.candidateId;
  }
  return Object.freeze({
    id,
    demigodReqId: input.demigodReqId,
    title: input.title,
    trialScope: trialScopeOf(input.trialScope),
    vettingRubric: rubricOf(input.vettingRubric),
    feePolicyRef: input.feePolicyRef,
    candidateId,
    budgetRecord: null,
    deliverableRef: null,
    rubricScores: null,
    verdict: null,
    blockedFrom: null,
    state: "proposed",
    history: Object.freeze([{ at: at(now), from: null, to: "proposed" }]),
  });
}

// funded = "trial budget recorded". RECORD-ONLY: no ledger movement.
export function fundTrialTask(task, budgetRecord, now) {
  requireState(task, "proposed");
  const record = budgetRecordOf(budgetRecord);
  return stamp(task, "proposed", "funded", at(now), { budgetRecord: record });
}

export function claimTrialTask(task, { candidateId } = {}, now) {
  requireState(task, "funded");
  check(isNonEmptyString(candidateId, 128), "missing_candidate_id",
    "claiming a trial task requires a candidateId.");
  return stamp(task, "funded", "claimed", at(now), { candidateId });
}

export function submitTrialTask(task, { deliverableRef } = {}, now) {
  requireState(task, "claimed");
  check(isNonEmptyString(deliverableRef, 512), "missing_deliverable_ref",
    "submitting a trial task requires a deliverableRef.");
  return stamp(task, "claimed", "submitted", at(now), { deliverableRef });
}

export function verdictTrialTask(task, { rubricScores, verdict } = {}, now) {
  requireState(task, "submitted");
  check(verdict === "pass" || verdict === "fail", "invalid_verdict",
    "verdict must be \"pass\" or \"fail\".");
  const scores = rubricScoresOf(task, rubricScores);
  return stamp(task, "submitted", "verdict", at(now), { rubricScores: scores, verdict });
}

// Receipting records the verdict. A failed verdict receipts too — the
// receipt is a record of completion, never a payout.
export function receiptTrialTask(task, { receiptRef } = {}, now) {
  requireState(task, "verdict");
  const extra = {};
  if (receiptRef !== undefined && receiptRef !== null) {
    check(isNonEmptyString(receiptRef, 512), "invalid_trial_task_input",
      "receiptRef must be a 1..512 character string.");
    extra.receiptRef = receiptRef;
  }
  return stamp(task, "verdict", "receipted", at(now), extra);
}

export function blockTrialTask(task, { reason } = {}, now) {
  if (task.state === "blocked" || TERMINAL_STATES.has(task.state)) {
    fail("illegal_transition", `cannot block a task in state "${task.state}".`,
      { from: task.state, to: "blocked", allowed: [...TRANSITIONS[task.state]] });
  }
  const extra = { blockedFrom: task.state };
  if (reason !== undefined && reason !== null) {
    check(isNonEmptyString(reason, 512), "invalid_trial_task_input",
      "block reason must be a 1..512 character string.");
    extra.blockReason = reason;
  }
  return stamp(task, task.state, "blocked", at(now), extra);
}

export function resumeTrialTask(task, now) {
  requireState(task, "blocked");
  check(task.blockedFrom && TRANSITIONS[task.blockedFrom], "illegal_transition",
    "blocked task has no resumable prior state.",
    { from: "blocked", to: null, allowed: [] });
  const to = task.blockedFrom;
  const resumed = stamp(task, "blocked", to, at(now), { blockedFrom: null });
  const out = { ...resumed };
  delete out.blockReason; // a resumed task is no longer blocked; the history entry keeps the record
  return Object.freeze(out);
}

export function releaseTrialTask(task, { reason } = {}, now) {
  if (TERMINAL_STATES.has(task.state)) {
    fail("illegal_transition", `cannot release a task in terminal state "${task.state}".`,
      { from: task.state, to: "released", allowed: [] });
  }
  const extra = {};
  if (reason !== undefined && reason !== null) {
    check(isNonEmptyString(reason, 512), "invalid_trial_task_input",
      "release reason must be a 1..512 character string.");
    extra.releaseReason = reason;
  }
  return stamp(task, task.state, "released", at(now), extra);
}

// --- registry (in-memory; a later slice persists) --------------------------------

export function createTrialTaskRegistry() {
  const items = new Map();
  return {
    get(id) { return items.get(id) ?? null; },
    set(task) { items.set(task.id, task); return task; },
    has(id) { return items.has(id); },
    list() { return [...items.values()]; },
    get size() { return items.size; },
  };
}
