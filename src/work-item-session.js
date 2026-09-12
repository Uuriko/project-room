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
  return { status: SESSION_STATUSES.QUEUED, stop_requested_at: null, heartbeat_at: null, worker_member_id: null };
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
  return { status, stop_requested_at: stop, heartbeat_at: heartbeat, worker_member_id: worker };
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
    accountableMemberId: item.accountableMemberId
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
    workItemFields: Object.freeze(["status", "stop_requested_at", "heartbeat_at", "worker_member_id"]),
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
  if (session.status === SESSION_STATUSES.QUEUED && nextStatus === SESSION_STATUSES.PROCESSING) {
    return SESSION_EVENT_TYPES.STARTED;
  }
  if (TERMINAL.has(nextStatus)) return SESSION_EVENT_TYPES.STOPPED;
  return SESSION_EVENT_TYPES.STATUS_CHANGED;
}

export function applySessionFields(item, incoming) {
  const session = sessionRecord(item);
  const at = incoming.at;
  if (incoming.type === SESSION_EVENT_TYPES.STARTED) {
    if (session.status !== SESSION_STATUSES.QUEUED || session.stop_requested_at) {
      throw new Error(`Invalid session transition from ${session.status}`);
    }
    item.status = SESSION_STATUSES.PROCESSING;
    item.stop_requested_at = null;
    item.heartbeat_at = at;
    item.worker_member_id = incoming.actorId;
    return;
  }
  if (incoming.type === SESSION_EVENT_TYPES.STATUS_CHANGED) {
    const next = incoming.data.status;
    if (!CHANGES[session.status]?.includes(next)) throw new Error(`Invalid session transition from ${session.status}`);
    item.status = next;
    item.stop_requested_at = session.stop_requested_at;
    item.heartbeat_at = at;
    item.worker_member_id = incoming.actorId;
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
    item.stop_requested_at = session.stop_requested_at;
    item.heartbeat_at = at;
    item.worker_member_id = null;
    return;
  }
  throw new Error(`Unsupported event type: ${incoming.type}`);
}
