// Q001: flaky-test quarantine system (auto-quarantine + ticket).
//
// This module answers "is this test flaky, should it be quarantined, and
// what ticket do we file about it". Callers record pass/fail outcomes per
// test id into an injectable history store, classify each test over a
// sliding window (STABLE: all passes, BROKEN: all failures, FLAKY: mixed,
// INSUFFICIENT: too few runs to judge), make quarantine decisions
// (QUARANTINE a newly-flaky or newly-broken test, KEEP the current state,
// REHABILITATE a quarantined test after enough consecutive passes), and
// build a ticket payload the caller files wherever tickets live.
// Pure functions, plain arguments, no I/O — history is kept in the
// caller-owned store (passed in and returned fresh, never mutated), and
// atMs is an injected clock so tests never touch a real clock.
//
// API:
//   STATUS_STABLE / STATUS_FLAKY / STATUS_BROKEN / STATUS_INSUFFICIENT —
//     the four classification outcomes over the sliding window.
//   DECISION_QUARANTINE / DECISION_KEEP / DECISION_REHABILITATE — the
//     three quarantine decisions. KEEP means "hold the current state"
//     (a quarantined test stays quarantined, an unquarantined test stays
//     unquarantined).
//   DEFAULT_POLICY — the stock policy: classify over the last 20 runs,
//     need at least 3 runs to judge, lift quarantine after 5 consecutive
//     passes.
//   createStore() — a fresh empty history store: { [testId]: record }.
//   createPolicy(overrides) — merge overrides over DEFAULT_POLICY and
//     validate; throws TypeError on a non-object, or on non-integer,
//     non-positive windowSize / minRuns / rehabilitateAfter, or when
//     minRuns exceeds windowSize.
//   recordOutcome(store, testId, passed, atMs) — return a new store with
//     the outcome appended to the test's record (input store untouched);
//     creates the record on first sight. atMs is optional; when given it
//     must be a non-negative finite number. Throws TypeError unless
//     testId is a non-empty string and passed is a boolean.
//   getRecord(store, testId) — the record for testId, or null when unseen.
//   windowOutcomes(record, windowSize) — the last windowSize outcomes as
//     booleans (oldest first), fewer when the record is shorter.
//   classifyOutcomes(outcomes, { minRuns }) — pure classification of a
//     boolean outcome list: fewer than minRuns -> INSUFFICIENT; all true
//     -> STABLE; all false -> BROKEN; mixed -> FLAKY.
//   consecutivePasses(record, windowSize) — trailing pass count within the
//     window (0 when the last run failed or history is empty).
//   summarizeHistory(record, windowSize) — { total, passes, fails,
//     passRate, lastOutcome, passStreak, quarantined } for tickets.
//   evaluateQuarantine(store, testId, policy) — pure decision: returns
//     { decision, status, summary }. An unquarantined FLAKY or BROKEN test
//     -> QUARANTINE; a quarantined test whose trailing pass streak reaches
//     rehabilitateAfter -> REHABILITATE; anything else -> KEEP. A test
//     rehabilitated while its old failures are still in the window is
//     re-quarantined on the next evaluation if the window is still mixed
//     (honest oscillation for a persistently flaky test). The policy
//     defaults to DEFAULT_POLICY. Unknown tests report STATUS_INSUFFICIENT
//     and DECISION_KEEP.
//   applyDecision(store, testId, decision, atMs) — return a new store with
//     the record's quarantined flag set (quarantine -> true,
//     rehabilitate -> false, keep -> unchanged) and quarantineAtMs
//     stamped on new quarantines.
//   buildTicketPayload(testId, { status, reason, summary, detector })
//     — { title, body, fields }: everything a caller needs to file the
//     quarantine ticket; the caller owns filing. Fields carry testId,
//     status, quarantine reason, a compact history summary, and the
//     detector id. atMs lives on the summary when recorded.
//
// Record shape: { testId, quarantined, quarantinedAtMs, history: [{ passed, atMs }] }
// Store shape: { [testId]: record } — plain object, caller-owned.

export const STATUS_STABLE = "stable";
export const STATUS_FLAKY = "flaky";
export const STATUS_BROKEN = "broken";
export const STATUS_INSUFFICIENT = "insufficient";

const STATUSES = new Set([
  STATUS_STABLE,
  STATUS_FLAKY,
  STATUS_BROKEN,
  STATUS_INSUFFICIENT
]);

export const DECISION_QUARANTINE = "quarantine";
export const DECISION_KEEP = "keep";
export const DECISION_REHABILITATE = "rehabilitate";

const DECISIONS = new Set([DECISION_QUARANTINE, DECISION_KEEP, DECISION_REHABILITATE]);

export const DEFAULT_POLICY = {
  name: "default-flaky-quarantine",
  version: 1,
  windowSize: 20,
  minRuns: 3,
  rehabilitateAfter: 5
};

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isPositiveInt = (v) => isFiniteNumber(v) && Number.isInteger(v) && v > 0;

function assertTestId(testId) {
  if (typeof testId !== "string" || testId.length === 0) {
    throw new TypeError(`testId must be a non-empty string, got ${String(testId)}`);
  }
}

function assertAtMs(atMs, where) {
  if (atMs !== undefined && (!isFiniteNumber(atMs) || atMs < 0)) {
    throw new TypeError(`${where}: atMs must be a non-negative finite number, got ${String(atMs)}`);
  }
}

function assertStore(store, where) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new TypeError(`${where}: store must be a store object from createStore, got ${String(store)}`);
  }
}

function assertRecord(record, where) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`${where}: record must be a test record object, got ${String(record)}`);
  }
  if (!Array.isArray(record.history)) {
    throw new TypeError(`${where}: record.history must be an array`);
  }
  for (const [index, entry] of record.history.entries()) {
    if (!entry || typeof entry !== "object" || typeof entry.passed !== "boolean") {
      throw new TypeError(`${where}: record.history[${index}].passed must be a boolean`);
    }
  }
}

function assertPolicyShape(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("policy must be an object");
  }
  for (const key of ["windowSize", "minRuns", "rehabilitateAfter"]) {
    if (!isPositiveInt(policy[key])) {
      throw new TypeError(
        `policy.${key} must be a positive integer, got ${String(policy[key])}`
      );
    }
  }
  if (policy.minRuns > policy.windowSize) {
    throw new TypeError(
      `policy.minRuns (${policy.minRuns}) cannot exceed policy.windowSize (${policy.windowSize})`
    );
  }
}

export function createStore() {
  return {};
}

export function createPolicy(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("overrides must be an object");
  }
  const merged = { ...DEFAULT_POLICY, ...overrides };
  assertPolicyShape(merged);
  return merged;
}

function freshRecord(testId) {
  return { testId, quarantined: false, quarantinedAtMs: null, history: [] };
}

export function recordOutcome(store, testId, passed, atMs) {
  assertStore(store, "recordOutcome");
  assertTestId(testId);
  if (typeof passed !== "boolean") {
    throw new TypeError(`passed must be a boolean, got ${String(passed)}`);
  }
  assertAtMs(atMs, "recordOutcome");
  const previous = store[testId] ? { ...store[testId], history: [...store[testId].history] } : freshRecord(testId);
  previous.history.push({ passed, atMs: atMs ?? null });
  return { ...store, [testId]: previous };
}

export function getRecord(store, testId) {
  assertStore(store, "getRecord");
  assertTestId(testId);
  return store[testId] ?? null;
}

export function windowOutcomes(record, windowSize) {
  assertRecord(record, "windowOutcomes");
  if (!isPositiveInt(windowSize)) {
    throw new TypeError(`windowSize must be a positive integer, got ${String(windowSize)}`);
  }
  return record.history.slice(-windowSize).map((entry) => entry.passed);
}

export function classifyOutcomes(outcomes, { minRuns }) {
  if (!Array.isArray(outcomes) || outcomes.some((o) => typeof o !== "boolean")) {
    throw new TypeError("outcomes must be an array of booleans");
  }
  if (!isPositiveInt(minRuns)) {
    throw new TypeError(`minRuns must be a positive integer, got ${String(minRuns)}`);
  }
  if (outcomes.length < minRuns) return STATUS_INSUFFICIENT;
  const failures = outcomes.filter((o) => !o).length;
  if (failures === 0) return STATUS_STABLE;
  if (failures === outcomes.length) return STATUS_BROKEN;
  return STATUS_FLAKY;
}

export function detectStatus(record, { windowSize, minRuns }) {
  return classifyOutcomes(windowOutcomes(record, windowSize), { minRuns });
}

export function consecutivePasses(record, windowSize) {
  assertRecord(record, "consecutivePasses");
  if (!isPositiveInt(windowSize)) {
    throw new TypeError(`windowSize must be a positive integer, got ${String(windowSize)}`);
  }
  const outcomes = windowOutcomes(record, windowSize);
  let streak = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (!outcomes[i]) break;
    streak++;
  }
  return streak;
}

export function summarizeHistory(record, windowSize) {
  assertRecord(record, "summarizeHistory");
  if (!isPositiveInt(windowSize)) {
    throw new TypeError(`windowSize must be a positive integer, got ${String(windowSize)}`);
  }
  const outcomes = windowOutcomes(record, windowSize);
  const total = outcomes.length;
  const passes = outcomes.filter(Boolean).length;
  const fails = total - passes;
  return {
    total,
    passes,
    fails,
    passRate: total === 0 ? null : passes / total,
    lastOutcome: total === 0 ? null : outcomes[outcomes.length - 1] ? "pass" : "fail",
    passStreak: consecutivePasses(record, windowSize),
    quarantined: record.quarantined === true
  };
}

export function evaluateQuarantine(store, testId, policy = DEFAULT_POLICY) {
  assertStore(store, "evaluateQuarantine");
  assertTestId(testId);
  assertPolicyShape(policy);
  const record = getRecord(store, testId);
  if (!record) {
    return {
      decision: DECISION_KEEP,
      status: STATUS_INSUFFICIENT,
      summary: null
    };
  }
  const status = detectStatus(record, policy);
  const summary = summarizeHistory(record, policy.windowSize);
  if (record.quarantined) {
    // Rehabilitation is driven by the trailing pass streak alone: the old
    // failures that triggered quarantine may still sit inside the window,
    // so we do not wait for the status to flip back to STABLE.
    const decision =
      summary.passStreak >= policy.rehabilitateAfter ? DECISION_REHABILITATE : DECISION_KEEP;
    return { decision, status, summary };
  }
  const decision =
    status === STATUS_FLAKY || status === STATUS_BROKEN ? DECISION_QUARANTINE : DECISION_KEEP;
  return { decision, status, summary };
}

export function applyDecision(store, testId, decision, atMs) {
  assertStore(store, "applyDecision");
  assertTestId(testId);
  if (!DECISIONS.has(decision)) {
    throw new TypeError(
      `decision must be one of quarantine|keep|rehabilitate, got ${String(decision)}`
    );
  }
  assertAtMs(atMs, "applyDecision");
  const record = getRecord(store, testId);
  if (!record) {
    throw new TypeError(`applyDecision: no record for testId ${JSON.stringify(testId)}`);
  }
  if (decision === DECISION_KEEP) return { ...store };
  const updated = { ...record, history: [...record.history] };
  if (decision === DECISION_QUARANTINE) {
    updated.quarantined = true;
    updated.quarantinedAtMs = atMs ?? null;
  } else {
    updated.quarantined = false;
    updated.quarantinedAtMs = null;
  }
  return { ...store, [testId]: updated };
}

const REASON_LINES = {
  [STATUS_FLAKY]: "mixed pass/fail results inside the sliding window (flaky)",
  [STATUS_BROKEN]: "all failures inside the sliding window (consistently broken)",
  [STATUS_STABLE]: "all passes inside the sliding window (stable)",
  [STATUS_INSUFFICIENT]: "too few runs inside the sliding window to judge"
};

export function buildTicketPayload(testId, { status, reason, summary, detector }) {
  assertTestId(testId);
  if (!STATUSES.has(status)) {
    throw new TypeError(
      `status must be one of stable|flaky|broken|insufficient, got ${String(status)}`
    );
  }
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new TypeError("summary must be a history summary object from summarizeHistory");
  }
  if (typeof detector !== "string" || detector.length === 0) {
    throw new TypeError(`detector must be a non-empty string, got ${String(detector)}`);
  }
  const quarantineReason = reason ?? REASON_LINES[status];
  if (typeof quarantineReason !== "string" || quarantineReason.length === 0) {
    throw new TypeError("reason must be a non-empty string when provided");
  }
  const title = `[flaky-test] quarantine review: ${testId} (${status})`;
  const historyLine =
    `runs: ${summary.total}, passes: ${summary.passes}, failures: ${summary.fails}, ` +
    `pass rate: ${summary.passRate === null ? "n/a" : `${(summary.passRate * 100).toFixed(1)}%`}, ` +
    `last outcome: ${summary.lastOutcome ?? "n/a"}, current pass streak: ${summary.passStreak}`;
  const body = [
    `Test \`${testId}\` was flagged by the flaky-test quarantine detector.`,
    "",
    `Status: ${status}`,
    `Reason: ${quarantineReason}`,
    `History (sliding window): ${historyLine}`,
    `Currently quarantined: ${summary.quarantined ? "yes" : "no"}`,
    "",
    "Next steps: investigate the failure, fix or mark the test, then let the",
    "quarantine system rehabilitate it automatically after enough consecutive passes."
  ].join("\n");
  return {
    title,
    body,
    fields: {
      testId,
      status,
      quarantineReason,
      historySummary: historyLine,
      quarantined: summary.quarantined,
      detector
    }
  };
}
