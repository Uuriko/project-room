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
    started_at: null, attempt_count: 0, budget: null, spend_cents: null, round_count: 0, tool_calls: 0,
    suspended_by: null };
}

// Replay backfill: rooms projected before work controls existed carry work
// items without the round/tool-call counters and suspension cause, and
// receipts without result segments. Backfill the deterministic defaults on
// replay so no data migration is needed (mirrors ensureDefaultChannel).
export function ensureWorkControlDefaults(state) {
  const items = state?.workItems;
  if (!items || typeof items !== "object") return;
  for (const item of Object.values(items)) {
    if (!item || typeof item !== "object") continue;
    if (!Number.isSafeInteger(item.round_count) || item.round_count < 0) item.round_count = 0;
    if (!Number.isSafeInteger(item.tool_calls) || item.tool_calls < 0) item.tool_calls = 0;
    if (item.suspended_by !== "round_limit") item.suspended_by = null;
    for (const receipt of [item.receipt, ...(item.receiptHistory ?? [])]) {
      if (receipt && typeof receipt === "object" && !("segments" in receipt)) receipt.segments = null;
    }
  }
}

// RC-2026-09-19-063: session budgets grow two bounds. A claimer may declare
// how many work-loop rounds one live session may run (maxRounds) and how many
// tool calls it may make (maxToolCalls); undeclared keys stay "unknown" —
// never assumed zero or unlimited.
export const SESSION_BUDGET_KEYS = Object.freeze(["maxRuntimeMs", "maxAttempts", "maxConcurrent", "maxSpendCents", "maxRounds", "maxToolCalls"]);
const BUDGET_CAPS = Object.freeze({ maxRuntimeMs: 30 * 86400000, maxAttempts: 1000, maxConcurrent: 25, maxSpendCents: 100000000, maxRounds: 10000, maxToolCalls: 1000000 });
export function validateSessionBudget(value) {
  if (value === undefined || value === null) return null;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Budget must be an object");
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !SESSION_BUDGET_KEYS.includes(key)))
    throw new Error("Budget keys are maxRuntimeMs, maxAttempts, maxConcurrent, maxSpendCents, maxRounds, maxToolCalls");
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
      outputs: Array.isArray(a.outputs) ? Object.freeze(a.outputs.filter(o => typeof o === "string")) : null,
      usageCents: Number.isSafeInteger(a.usageCents) ? a.usageCents : null
    })));
}

// The tripped limit name when a live session has blown its budget, else null.
// Spend and tool calls only trip where the worker actually reported them —
// unknown usage is not evidence of anything.
export function budgetLimitExceeded(item, nowMs = Date.now()) {
  const session = sessionRecord(item);
  if (isTerminalSession(session.status) || !session.budget) return null;
  if (session.budget.maxRuntimeMs && session.started_at && Number.isFinite(nowMs)
    && nowMs - Date.parse(session.started_at) > session.budget.maxRuntimeMs) return "maxRuntimeMs";
  if (session.budget.maxSpendCents && session.spend_cents !== null && session.spend_cents > session.budget.maxSpendCents)
    return "maxSpendCents";
  if (session.budget.maxToolCalls && session.tool_calls > session.budget.maxToolCalls)
    return "maxToolCalls";
  return null;
}

// RC-2026-09-19-063: the round limit pauses instead of stopping — a worker
// that blew its round budget must report status and wait for the owner, not
// silently die. pendingRounds lets the trip-wire count the number reported on
// the very mutation being processed.
export function roundLimitExceeded(item, pendingRounds = null) {
  const session = sessionRecord(item);
  if (isTerminalSession(session.status) || session.budget?.maxRounds == null) return false;
  const rounds = pendingRounds ?? session.round_count;
  return Number.isSafeInteger(rounds) && rounds > session.budget.maxRounds;
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
  const rounds = Number.isSafeInteger(item.round_count) && item.round_count >= 0 ? item.round_count : 0;
  const toolCalls = Number.isSafeInteger(item.tool_calls) && item.tool_calls >= 0 ? item.tool_calls : 0;
  const suspendedBy = item.suspended_by === "round_limit" ? "round_limit" : null;
  return { status, stop_requested_at: stop, heartbeat_at: heartbeat, worker_member_id: worker,
    started_at: started, attempt_count: attempts, budget, spend_cents: spend, round_count: rounds,
    tool_calls: toolCalls, suspended_by: suspendedBy, attempts: attemptLedger(item) };
}

// The member currently holding a live claim on this session, or null when the
// session is not running or its heartbeat went stale (abandoned: takeable).
export function sessionWorker(item, nowMs = Date.now()) {
  const session = sessionRecord(item);
  if (!RUNNING.has(session.status) || !session.worker_member_id || !session.heartbeat_at) return null;
  if (Number.isFinite(nowMs) && nowMs - Date.parse(session.heartbeat_at) > SESSION_HEARTBEAT_STALE_MS) return null;
  return session.worker_member_id;
}

// Presentation only: completed work must not keep a never-started session
// card on queued, or Done chips look stuck. The ledger status stays queued
// on sessionRecord — this does not rewrite history.
export function presentedSessionStatus(item) {
  const session = sessionRecord(item);
  if (session.status === SESSION_STATUSES.QUEUED && item?.state === "completed") return SESSION_STATUSES.DONE;
  return session.status;
}

export function sessionCard(item, cancellation = null) {
  const session = sessionRecord(item);
  return {
    workItemId: item.id,
    title: item.title,
    status: presentedSessionStatus(item),
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
    // RC-2026-09-19-063: the counters behind the round and tool-call bounds,
    // plus why a session is paused. Unreported rounds/calls read 0 — a
    // worker that never reported any ran none that it counted.
    rounds: session.round_count,
    toolCalls: session.tool_calls,
    suspendedBy: session.suspended_by,
    attempts: session.attempts,
    receipts: attemptReceipts(item),
    cancellation
  };
}

export function listWorkItemSessions(workItems, status = null, { members = null, nowMs = Date.now() } = {}) {
  if (status != null && !isSessionStatus(status)) throw new RangeError("Choose one session status");
  return Object.values(workItems ?? {})
    .filter(item => item && typeof item === "object" && item.supersededBy == null && item.state !== "superseded")
    .map(item => {
      const worker = sessionRecord(item).worker_member_id;
      const workerActive = members && worker ? members[worker]?.active !== false : true;
      return sessionCard(item, cancellationState(item, { nowMs, workerActive }));
    })
    .filter(card => status == null || card.status === status)
    .sort((a, b) => a.workItemId < b.workItemId ? -1 : 1);
}

// W4-41 G6: output and usage receipts. Exact output references and measured
// usage are linked per attempt and kept separate from budget estimates. A
// done attempt with missing artifacts or unknown usage reads as an
// unverified success - it cannot present as a success claim.
export function attemptReceipts(item) {
  const session = sessionRecord(item);
  return Object.freeze(session.attempts.map(a => Object.freeze({
    attempt: a.attempt,
    outcome: a.outcome,
    outputs: a.outputs, // exact references; null = missing artifacts
    usageCents: a.usageCents ?? null, // measured at close; null = unknown
    estimateCents: a.limits?.maxSpendCents ?? null, // the estimate, kept apart from measurement
    successClaim: a.outcome !== "done" ? "not-claimed"
      : (Array.isArray(a.outputs) && a.outputs.length > 0 && Number.isSafeInteger(a.usageCents) ? "verified" : "unverified")
  })));
}

// W4-42 G7: meaningful cancellation. The four stops stay distinct, and
// silence is never read as termination: a stale heartbeat is "unresponsive"
// (process state unknown), which is exactly what a lost worker looks like.
// Read-time derivation only; nothing historical is rewritten.
export function cancellationState(item, { nowMs = Date.now(), workerActive = true } = {}) {
  const session = sessionRecord(item);
  const stopped = TERMINAL.has(session.status);
  const unresponsive = !stopped && typeof session.heartbeat_at === "string"
    && Number.isFinite(nowMs) && nowMs - Date.parse(session.heartbeat_at) > SESSION_HEARTBEAT_STALE_MS;
  return Object.freeze({
    // A polite signal was sent; the run may still be live.
    stopRequested: !stopped && session.stop_requested_at !== null,
    // A budget wire forbids further dispatch (name of the tripped limit).
    dispatchDisabled: stopped ? null : budgetLimitExceeded(item, nowMs),
    // The worker's access was revoked while a run shows live.
    accessRevoked: !stopped && workerActive === false && session.worker_member_id !== null,
    // An actual stop event landed (done/failed). The only termination proof.
    runtimeStopped: stopped,
    // Silence: heartbeat stale. Never infer termination from this.
    unresponsive
  });
}

// Shared read-time presentation. A missing heartbeat is uncertainty, never
// permission to duplicate a worker or proof that its process stopped.
export function workContinuity(item, nowMs = Date.now()) {
  const session = sessionRecord(item);
  if (!session.attempt_count && !session.started_at) return null;
  const common = { attempt: session.attempt_count, lastUpdate: session.heartbeat_at };
  if (session.status === "done") return { ...common, state: "finished", label: "Run finished", needsAttention: false };
  if (session.status === "failed") return { ...common, state: "interrupted", label: "Run interrupted", needsAttention: true,
    next: "Read saved progress before retrying or handing off." };
  const flags = cancellationState(item, { nowMs });
  if (flags.stopRequested) return { ...common, state: "stopping", label: "Stop requested", needsAttention: true,
    next: "Confirm the worker stopped before starting another run." };
  if (flags.unresponsive || !session.heartbeat_at) return { ...common, state: "unknown", label: "Waiting for a worker update", needsAttention: true,
    next: "Process state is unknown. Check the worker and saved progress before resuming." };
  if (session.status === "suspended") return { ...common, state: "paused", label: "Run paused", needsAttention: true,
    next: session.suspended_by === "round_limit" ? "The owner can resume this run after reviewing its round limit." : "Read saved progress to continue or hand off." };
  return { ...common, state: "running", label: "Worker checked in", needsAttention: false };
}

export function workItemSessionContract() {
  return {
    status: "live",
    schemaBump: false,
    writer: 27,
    workItemFields: Object.freeze(["status", "stop_requested_at", "heartbeat_at", "worker_member_id",
      "started_at", "attempt_count", "budget", "spend_cents", "round_count", "tool_calls", "suspended_by", "attempts"]),
    statuses: SESSION_STATUS_LIST,
    events: SESSION_EVENT_LIST,
    workStateSeparate: false,
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

// RC-2026-09-19-063: rounds and tool calls are cumulative worker reports —
// monotonic, so a stale or malicious report can never rewind the counters.
export function reportRounds(item, incoming) {
  if (incoming.data?.rounds === undefined) return;
  const value = incoming.data.rounds;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("rounds must be a non-negative integer");
  item.round_count = Math.max(item.round_count ?? 0, value);
}

export function reportToolCalls(item, incoming) {
  if (incoming.data?.toolCalls === undefined) return;
  const value = incoming.data.toolCalls;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("toolCalls must be a non-negative integer");
  item.tool_calls = Math.max(item.tool_calls ?? 0, value);
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
    item.round_count = 0;
    item.tool_calls = 0;
    item.suspended_by = null;
    (Array.isArray(item.attempts) ? item.attempts : (item.attempts = [])).push({
      attempt: attempts, performer: incoming.actorId, startedAt: at, inputRevision: item.revision,
      environment, limits: budget, endedAt: null, outcome: null, outputs: null });
    // #603: claiming (set_status: processing) automatically moves the work
    // item to accepted. The lifecycle and session ladders are unified.
    if (item.state === "proposed") item.state = "accepted";
    return;
  }
  if (incoming.type === SESSION_EVENT_TYPES.STATUS_CHANGED) {
    const next = incoming.data.status;
    if (!CHANGES[session.status]?.includes(next)) throw new Error(`Invalid session transition from ${session.status}`);
    // RC-2026-09-19-063: a round-limit pause is recorded, and only an
    // owner-approved resume clears it (with a fresh round count). A worker
    // cannot dodge the limit by suspending and resuming on its own: the
    // resume gate lives in the store, and the applier re-checks it so a
    // tampered log entry cannot smuggle a resume past.
    if (next === SESSION_STATUSES.SUSPENDED && incoming.data?.suspendReason !== undefined
      && incoming.data.suspendReason !== "round_limit") throw new Error("suspendReason is round_limit or omitted");
    if (session.status === SESSION_STATUSES.SUSPENDED && session.suspended_by === "round_limit") {
      if (next !== SESSION_STATUSES.SUSPENDED && incoming.data?.resumeApproved !== true)
        throw new Error("A round-limit pause resumes only with owner approval");
    } else if (next === SESSION_STATUSES.SUSPENDED) {
      item.suspended_by = incoming.data?.suspendReason === "round_limit" ? "round_limit" : null;
    } else {
      item.suspended_by = null;
    }
    item.status = next;
    item.stop_requested_at = session.stop_requested_at;
    item.heartbeat_at = at;
    // An owner-approved resume hands the session back to the worker that was
    // paused — the owner supervises, the worker continues.
    item.worker_member_id = incoming.data?.resumeApproved === true && session.worker_member_id
      ? session.worker_member_id : incoming.actorId;
    reportSpend(item, incoming);
    reportRounds(item, incoming);
    reportToolCalls(item, incoming);
    // The approved resume restarts the round count AFTER any reports on the
    // resume event itself — those belong to the previous generation.
    if (incoming.data?.resumeApproved === true) {
      item.suspended_by = null;
      item.round_count = 0;
    }
    // #603: first active heartbeat automatically moves the work item to
    // working (started). The lifecycle and session ladders are unified.
    if (next === SESSION_STATUSES.ACTIVE && item.state === "accepted") item.state = "working";
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
    item.stop_requested_at = session.stop_requested_at;
    item.heartbeat_at = at;
    item.worker_member_id = null;
    reportSpend(item, incoming);
    reportRounds(item, incoming);
    reportToolCalls(item, incoming);
    // G6: capture measured usage at close; a later attempt resets item spend.
    if (openAttempt) { openAttempt.endedAt = at; openAttempt.outcome = next; openAttempt.outputs = outputs;
      openAttempt.usageCents = Number.isSafeInteger(item.spend_cents) ? item.spend_cents : null; }
    // #603: release/expiry without completion moves the work item back to
    // proposed. Completed work stays completed.
    if ((item.state === "accepted" || item.state === "working") && next !== "done") item.state = "proposed";
    return;
  }
  throw new Error(`Unsupported event type: ${incoming.type}`);
}

// Issue #6 C3: the room spend ledger behind a room-level allowance. Derived
// from the projection alone, so the server check, the read route and the
// browser card all compute the same figures from the same state.
//
// - spentCents is the spend agents reported: measured usage at close for
//   attempts that closed inside the period, plus the latest cumulative
//   report of every live session (a live session always counts, however old).
// - reservedCents is what live sessions may still spend under their declared
//   maxSpendCents; a live session that declared no cap reserves nothing and
//   is counted in sessions.unreserved so the gap is visible, never assumed zero.
// - heldCents keeps the declared cap of every closed attempt in the period
//   that never reported spend: unknown spend is held at its reservation, so
//   it can never free allowance for the next start. Attempts with neither a
//   report nor a cap are counted in sessions.attemptsUnreported and add nothing.
export function spendLedger(state, { nowMs = Date.now(), periodDays = 30 } = {}) {
  const since = nowMs - periodDays * 86400000;
  const ledger = { periodDays, since: new Date(since).toISOString(), until: new Date(nowMs).toISOString(),
    spentCents: 0, reservedCents: 0, heldCents: 0, committedCents: 0,
    sessions: { live: 0, unreserved: 0, attemptsCounted: 0, attemptsUnreported: 0, attemptsHeld: 0 } };
  for (const item of Object.values(state?.workItems ?? {})) {
    if (!item || typeof item !== "object") continue;
    const session = sessionRecord(item);
    for (const attempt of session.attempts) {
      if (attempt.endedAt === null) continue; // the open attempt is the live session below
      if (Date.parse(attempt.endedAt) < since) continue;
      ledger.sessions.attemptsCounted++;
      if (attempt.usageCents !== null) ledger.spentCents += attempt.usageCents;
      else if (Number.isSafeInteger(attempt.limits?.maxSpendCents)) { ledger.heldCents += attempt.limits.maxSpendCents; ledger.sessions.attemptsHeld++; }
      else ledger.sessions.attemptsUnreported++;
    }
    if (!RUNNING.has(session.status)) continue;
    ledger.sessions.live++;
    ledger.sessions.attemptsCounted++;
    const reported = session.spend_cents; // a live run that has not reported yet is covered by its reservation
    if (reported !== null) ledger.spentCents += reported;
    const cap = session.budget?.maxSpendCents ?? null;
    if (cap === null) ledger.sessions.unreserved++;
    else ledger.reservedCents += Math.max(0, cap - (reported ?? 0));
  }
  ledger.committedCents = ledger.spentCents + ledger.reservedCents + ledger.heldCents;
  return ledger;
}
