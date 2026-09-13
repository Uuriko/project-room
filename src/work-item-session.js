// Work Item session ledger. Parallel to work.state (proposed/accepted/…).
// Additive JSON on the existing events table — no writer bump.
// Not Compute, not Slack-with-bots UI, not people-data.

export const SESSION_STATUSES = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DONE: "done",
  FAILED: "failed"
});

export const SESSION_STATUS_LIST = Object.freeze(Object.values(SESSION_STATUSES));

export const SESSION_EVENT_TYPES = Object.freeze({
  STARTED: "session.started",
  STATUS_CHANGED: "session.status_changed",
  STOP_REQUESTED: "session.stop_requested",
  STOPPED: "session.stopped"
});

export const SESSION_EVENT_LIST = Object.freeze(Object.values(SESSION_EVENT_TYPES));

const RUNNING = new Set([SESSION_STATUSES.PROCESSING, SESSION_STATUSES.ACTIVE, SESSION_STATUSES.SUSPENDED]);

// A running session whose heartbeat is older than this is considered abandoned:
// another agent may take it over instead of waiting forever.
export const SESSION_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const TERMINAL = new Set([SESSION_STATUSES.DONE, SESSION_STATUSES.FAILED]);
const STATUS_SET = new Set(SESSION_STATUS_LIST);

const CHANGES = Object.freeze({
  [SESSION_STATUSES.PROCESSING]: Object.freeze([SESSION_STATUSES.ACTIVE, SESSION_STATUSES.SUSPENDED]),
  [SESSION_STATUSES.ACTIVE]: Object.freeze([SESSION_STATUSES.PROCESSING, SESSION_STATUSES.SUSPENDED]),
  [SESSION_STATUSES.SUSPENDED]: Object.freeze([SESSION_STATUSES.PROCESSING, SESSION_STATUSES.ACTIVE])
});

export function isSessionStatus(value) {
  return STATUS_SET.has(value);
}

export function isTerminalSession(status) {
  return TERMINAL.has(status);
}

export function isRunningSession(status) {
  return RUNNING.has(status);
}

export function defaultWorkItemSession() {
  return { status: SESSION_STATUSES.QUEUED, stop_requested_at: null, heartbeat_at: null, worker_member_id: null,
    started_at: null, attempt_count: 0, budget: null, spend_cents: null };
}

// W4-46 H5: session budgets. A claimer may declare bounds for their run;
// undeclared keys stay "unknown" — never assumed zero or unlimited.
export const SESSION_BUDGET_KEYS = Object.freeze(["maxRuntimeMs", "maxAttempts", "maxConcurrent", "maxSpendCents"]);
const BUDGET_CAPS = Object.freeze({ maxRuntimeMs: 30 * 86400000, maxAttempts: 1000, maxConcurrent: 25, maxSpendCents: 100000000 });
export function validateSessionBudget(value) {
  if (value === undefined || value === null) return null;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Budget must be an object");
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !SESSION_BUDGET_KEYS.includes(key)))
    throw new Error("Budget keys are maxRuntimeMs, maxAttempts, maxConcurrent, maxSpendCents");
  const budget = {};
  for (const key of keys) {
    const entry = value[key];
    if (!Number.isSafeInteger(entry) || entry < 1 || entry > BUDGET_CAPS[key])
      throw new Error(`Budget ${key} must be an integer 1-${BUDGET_CAPS[key]}`);
    budget[key] = entry;
  }
  return budget;
}
// The budget as the worker sees it: every undeclared quota is labeled
// "unknown" so a missing limit can never be mistaken for a granted one.
export function budgetCard(budget) {
  const card = {};
  for (const key of SESSION_BUDGET_KEYS) card[key] = budget?.[key] ?? "unknown";
  return Object.freeze(card);
}
// G1: attempt contract. Every session start records an attributable attempt:
// input version (the work revision it started against), performer, the declared
// environment and the limits in force; a stop closes the attempt with its
// outcome and output references. The ledger derives during replay - historical
// events carry no attempt fields and derive nulls, never errors.
export function validateAttemptEnvironment(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new Error("Environment is a string of 1-200 characters");
  return value;
}

export function validateAttemptOutputs(value) {
  if (value === undefined || value === null) return null;
  // Legacy session stops carried outputs as one free-text string; replay keeps it.
  if (typeof value === "string") {
    if (!value.trim() || value.length > 500) throw new Error("Outputs are 1-10 references, each a string of 1-500 characters");
    return [value];
  }
  if (!Array.isArray(value) || !value.length || value.length > 10
    || value.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 500))
    throw new Error("Outputs are 1-10 references, each a string of 1-500 characters");
  return [...value];
}

export function attemptLedger(item) {
  const list = Array.isArray(item?.attempts) ? item.attempts : [];
  return Object.freeze(list.filter(a => a && typeof a === "object" && !Array.isArray(a)
    && Number.isSafeInteger(a.attempt) && a.attempt >= 1
    && typeof a.performer === "string" && typeof a.startedAt === "string")
    .map(a => Object.freeze({
      attempt: a.attempt,
      performer: a.performer,
      startedAt: a.startedAt,
      inputRevision: Number.isSafeInteger(a.inputRevision) ? a.inputRevision : null,
      environment: typeof a.environment === "string" ? a.environment : null,
      limits: a.limits && typeof a.limits === "object" && !Array.isArray(a.limits) ? Object.freeze({ ...a.limits }) : null,
      endedAt: typeof a.endedAt === "string" ? a.endedAt : null,
      outcome: a.outcome === "done" || a.outcome === "failed" ? a.outcome : null,
      outputs: Array.isArray(a.outputs) ? Object.freeze(a.outputs.filter(o => typeof o === "string")) : null
    })));
}

// The tripped limit name when a live session has blown its budget, else null.
// Spend only trips where spend is actually reported — unknown spend is not
// evidence of anything.
export function budgetLimitExceeded(item, nowMs = Date.now()) {
  const session = sessionRecord(item);
  if (isTerminalSession(session.status) || !session.budget) return null;
  if (session.budget.maxRuntimeMs && session.started_at && Number.isFinite(nowMs)
    && nowMs - Date.parse(session.started_at) > session.budget.maxRuntimeMs) return "maxRuntimeMs";
  if (session.budget.maxSpendCents && session.spend_cents !== null && session.spend_cents > session.budget.maxSpendCents)
    return "maxSpendCents";
  return null;
}

export function sessionRecord(item) {
  const fallback = defaultWorkItemSession();
  if (!item || typeof item !== "object") return fallback;
  const status = isSessionStatus(item.status) ? item.status : fallback.status;
  const stop = typeof item.stop_requested_at === "string" && Number.isFinite(Date.parse(item.stop_requested_at))
    ? item.stop_requested_at : null;
  const heartbeat = typeof item.heartbeat_at === "string" && Number.isFinite(Date.parse(item.heartbeat_at))
    ? item.heartbeat_at : null;
  const worker = typeof item.worker_member_id === "string" && item.worker_member_id ? item.worker_member_id : null;
  let budget = null;
  try { budget = validateSessionBudget(item.budget); } catch { budget = null; }
  const started = typeof item.started_at === "string" && Number.isFinite(Date.parse(item.started_at)) ? item.started_at : null;
  const attempts = Number.isSafeInteger(item.attempt_count) && item.attempt_count >= 0 ? item.attempt_count : 0;
  const spend = Number.isSafeInteger(item.spend_cents) && item.spend_cents >= 0 ? item.spend_cents : null;
  return { status, stop_requested_at: stop, heartbeat_at: heartbeat, worker_member_id: worker,
    started_at: started, attempt_count: attempts, budget, spend_cents: spend, attempts: attemptLedger(item) };
}

// The member currently holding a live claim on this session, or null when the
// session is not running or its heartbeat went stale (abandoned: takeable).
export function sessionWorker(item, nowMs = Date.now()) {
  const session = sessionRecord(item);
  if (!RUNNING.has(session.status) || !session.worker_member_id || !session.heartbeat_at) return null;
  if (Number.isFinite(nowMs) && nowMs - Date.parse(session.heartbeat_at) > SESSION_HEARTBEAT_STALE_MS) return null;
  return session.worker_member_id;
}

export function sessionCard(item) {
  const session = sessionRecord(item);
  return {
    workItemId: item.id,
    title: item.title,
    status: session.status,
    stop_requested_at: session.stop_requested_at,
    heartbeat_at: session.heartbeat_at,
    worker_member_id: session.worker_member_id,
    revision: item.revision,
    state: item.state,
    accountableMemberId: item.accountableMemberId,
    // The limits this run can see: undeclared quotas are labeled "unknown",
    // and unreported spend is "unknown" — never assumed.
    budget: budgetCard(session.budget),
    started_at: session.started_at,
    attempt_count: session.attempt_count,
    spendCents: session.spend_cents ?? "unknown",
    attempts: session.attempts
  };
}

export function listWorkItemSessions(workItems, status = null) {
  if (status != null && !isSessionStatus(status)) throw new RangeError("Choose one session status");
  return Object.values(workItems ?? {})
    .filter(item => item && typeof item === "object" && item.supersededBy == null && item.state !== "superseded")
    .map(sessionCard)
    .filter(card => status == null || card.status === status)
    .sort((a, b) => a.workItemId < b.workItemId ? -1 : 1);
}

export function workItemSessionContract() {
  return {
    status: "live",
    schemaBump: false,
    writer: 27,
    workItemFields: Object.freeze(["status", "stop_requested_at", "heartbeat_at", "worker_member_id",
      "started_at", "attempt_count", "budget", "spend_cents", "attempts"]),
    statuses: SESSION_STATUS_LIST,
    events: SESSION_EVENT_LIST,
    workStateSeparate: true,
    compute: false,
    slackWithBotsUi: false,
    peopleData: false,
    designer: false
  };
}

export function sessionCommandType(item, action, nextStatus) {
  const session = sessionRecord(item);
  if (action === "request_stop") return SESSION_EVENT_TYPES.STOP_REQUESTED;
  if (action !== "set_status") throw new Error("Choose set_status or request_stop");
  if (!isSessionStatus(nextStatus)) throw new Error("Choose a session status");
  // A finished (done/failed) session may be started again: that is a retry, so
  // it goes through session.started and counts another attempt.
  if ((session.status === SESSION_STATUSES.QUEUED || TERMINAL.has(session.status)) && nextStatus === SESSION_STATUSES.PROCESSING) {
    return SESSION_EVENT_TYPES.STARTED;
  }
  if (TERMINAL.has(nextStatus)) return SESSION_EVENT_TYPES.STOPPED;
  return SESSION_EVENT_TYPES.STATUS_CHANGED;
}

function reportSpend(item, incoming) {
  if (incoming.data?.spendCents === undefined) return;
  const value = incoming.data.spendCents;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("spendCents must be a non-negative integer of cents");
  item.spend_cents = value;
}

export function applySessionFields(item, incoming) {
  const session = sessionRecord(item);
  const at = incoming.at;
  if (incoming.type === SESSION_EVENT_TYPES.STARTED) {
    // A first start needs a queued session with no stop pending. A session that
    // already finished (done/failed) may start again as a retry: attempt_count
    // grows, heartbeat/stop/worker fields reset, and a declared maxAttempts is
    // enforced here so the budget is unreachable by no path. A retry that
    // declares no budget keeps the previous one — silence never widens a limit.
    const retry = TERMINAL.has(session.status);
    if (!retry && (session.status !== SESSION_STATUSES.QUEUED || session.stop_requested_at)) {
      throw new Error(`Invalid session transition from ${session.status}`);
    }
    const budget = incoming.data?.budget == null && retry ? session.budget : validateSessionBudget(incoming.data?.budget);
    const attempts = session.attempt_count + 1;
    if (budget?.maxAttempts && attempts > budget.maxAttempts) {
      throw new Error(`Invalid session retry: attempt ${attempts} exceeds the attempt budget of ${budget.maxAttempts}`);
    }
    const environment = validateAttemptEnvironment(incoming.data?.environment);
    item.status = SESSION_STATUSES.PROCESSING;
    item.stop_requested_at = null;
    item.heartbeat_at = at;
    item.worker_member_id = incoming.actorId;
    item.started_at = at;
    item.attempt_count = attempts;
    item.budget = budget;
    item.spend_cents = null;
    (Array.isArray(item.attempts) ? item.attempts : (item.attempts = [])).push({
      attempt: attempts, performer: incoming.actorId, startedAt: at, inputRevision: item.revision,
      environment, limits: budget, endedAt: null, outcome: null, outputs: null });
    return;
  }
  if (incoming.type === SESSION_EVENT_TYPES.STATUS_CHANGED) {
    const next = incoming.data.status;
    if (!CHANGES[session.status]?.includes(next)) throw new Error(`Invalid session transition from ${session.status}`);
    item.status = next;
    item.stop_requested_at = session.stop_requested_at;
    item.heartbeat_at = at;
    item.worker_member_id = incoming.actorId;
    reportSpend(item, incoming);
    return;
  }
  if (incoming.type === SESSION_EVENT_TYPES.STOP_REQUESTED) {
    if (TERMINAL.has(session.status)) throw new Error(`Invalid session transition from ${session.status}`);
    if (session.stop_requested_at) throw new Error("Stop already requested");
    item.status = session.status;
    item.stop_requested_at = at;
    item.heartbeat_at = at;
    return;
  }
  if (incoming.type === SESSION_EVENT_TYPES.STOPPED) {
    const next = incoming.data.status;
    if (!TERMINAL.has(next)) throw new Error("Stopped session status must be done or failed");
    if (TERMINAL.has(session.status)) throw new Error(`Invalid session transition from ${session.status}`);
    item.status = next;
    const outputs = validateAttemptOutputs(incoming.data?.outputs);
    const attemptsList = Array.isArray(item.attempts) ? item.attempts : [];
    const openAttempt = attemptsList.findLast(a => a && typeof a === "object" && a.endedAt == null) ?? null;
    if (openAttempt) { openAttempt.endedAt = at; openAttempt.outcome = next; openAttempt.outputs = outputs; }
    item.stop_requested_at = session.stop_requested_at;
    item.heartbeat_at = at;
    item.worker_member_id = null;
    reportSpend(item, incoming);
    return;
  }
  throw new Error(`Unsupported event type: ${incoming.type}`);
}
