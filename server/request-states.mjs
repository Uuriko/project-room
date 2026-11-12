// Request lifecycle states. On by default; ROOM_REQUEST_STATES=0 turns them off.
// Pure: derives one display state for a formal request from its record and
// optional signals, so agents and the UI read "where is this request" without
// re-reading message history. States: pending, active, needs_input, error,
// complete, stale. `unresponsive` marks an open request whose recipient has
// not acknowledged within ACK_WINDOW_MS (about 10s). Every result carries
// `thresholds` so readers see the exact windows the state was judged by.
export const REQUEST_STATES = Object.freeze(["pending", "active", "needs_input", "error", "complete", "stale"]);
export const ACK_WINDOW_MS = 10_000;
export const STALE_AFTER_MS = 30 * 60 * 1000; // 30 min: an untouched open request is stale well inside a working session

// The states follow the agent model the room adopted on 2026-11-10: an ask is
// pending until its recipient reports progress, and reads `unresponsive` once
// the ack window passes without one. The field is additive, so the only
// reason to switch it off is a reader that rejects unknown keys.
export const requestStatesEnabled = (env = globalThis.process?.env) => env?.ROOM_REQUEST_STATES !== "0";

const ms = value => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

// Separate clocks for received / accepted / working / completed, present only once the recipient
// has explicitly accepted (progress "accepted"). Every request that predates it keeps its exact
// shape, so clients that validate the lifecycle key set keep working. `receivedAt` is the first
// report from the recipient, not proof of delivery: an acknowledgement alone proves neither
// acceptance nor progress.
function stagesOf(request, state) {
  if (ms(request.acceptedAt) === null) return null;
  return {
    stage: state === "complete" ? "completed" : ["needs_input", "error", "stale"].includes(state) ? state
      : ms(request.workingAt) !== null ? "working" : "accepted",
    receivedAt: request.acknowledgedAt ?? null, acceptedAt: request.acceptedAt, workingAt: request.workingAt ?? null,
    completedAt: state === "complete" ? (request.closedAt ?? null) : null };
}

// request: { status, createdAt, closedAt?, acknowledgedAt?, needsInputAt?, errorAt?, lastActivityAt? }
// status is the stored request status: open | answered | declined | cancelled.
export function deriveRequestState(request, { now = Date.now(), ackWindowMs = ACK_WINDOW_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  const thresholds = { ackWindowMs, staleAfterMs };
  const created = ms(request?.createdAt);
  if (!request || created === null) return { state: "pending", unresponsive: false, since: null, thresholds };
  const status = request.status;
  if (status === "answered" || status === "declined" || status === "cancelled") {
    const stages = stagesOf(request, "complete");
    return { state: "complete", outcome: status, unresponsive: false, since: request.closedAt ?? null, thresholds, ...(stages ? { stages } : {}) };
  }
  const acked = ms(request.acknowledgedAt);
  const needsInput = ms(request.needsInputAt);
  const errored = ms(request.errorAt);
  const last = Math.max(created, acked ?? 0, needsInput ?? 0, errored ?? 0, ms(request.lastActivityAt) ?? 0);
  // Latest explicit signal wins between error and needs_input.
  let state = acked === null ? "pending" : "active", since = acked === null ? request.createdAt : request.acknowledgedAt;
  if (needsInput !== null && (errored === null || needsInput >= errored)) { state = "needs_input"; since = request.needsInputAt; }
  else if (errored !== null) { state = "error"; since = request.errorAt; }
  if ((state === "pending" || state === "active") && now - last > staleAfterMs) state = "stale";
  const unresponsive = acked === null && needsInput === null && errored === null && now - created > ackWindowMs;
  const result = { state, unresponsive, since, thresholds };
  const stages = stagesOf(request, state);
  if (stages) result.stages = stages;
  return result;
}

// Adds `lifecycle` to a compact request unless the kill switch is set.
export function withRequestState(compact, request, options = {}) {
  if (!requestStatesEnabled(options.env)) return compact;
  return { ...compact, lifecycle: deriveRequestState(request, options) };
}
