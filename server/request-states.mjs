// Request lifecycle states (flag ROOM_REQUEST_STATES=1, off by default).
// Pure: derives one display state for a formal request from its record and
// optional signals, so agents and the UI read "where is this request" without
// re-reading message history. States: pending, active, needs_input, error,
// complete, stale. `unresponsive` marks an open request whose recipient has
// not acknowledged within ACK_WINDOW_MS (about 10s).
export const REQUEST_STATES = Object.freeze(["pending", "active", "needs_input", "error", "complete", "stale"]);
export const ACK_WINDOW_MS = 10_000;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const requestStatesEnabled = (env = globalThis.process?.env) => env?.ROOM_REQUEST_STATES === "1";

const ms = value => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

// request: { status, createdAt, closedAt?, acknowledgedAt?, needsInputAt?, errorAt?, lastActivityAt? }
// status is the stored request status: open | answered | declined | cancelled.
export function deriveRequestState(request, { now = Date.now(), ackWindowMs = ACK_WINDOW_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  const created = ms(request?.createdAt);
  if (!request || created === null) return { state: "pending", unresponsive: false, since: null };
  const status = request.status;
  if (status === "answered" || status === "declined" || status === "cancelled") {
    return { state: "complete", outcome: status, unresponsive: false, since: request.closedAt ?? null };
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
  return { state, unresponsive, since };
}

// Adds `lifecycle` to a compact request only when the flag is on.
export function withRequestState(compact, request, options = {}) {
  if (!requestStatesEnabled(options.env)) return compact;
  return { ...compact, lifecycle: deriveRequestState(request, options) };
}

// The selected-read `request` object is key-exact for shipped clients
// (client/reply-actions.mjs). Lifecycle signals stay internal to the record.
const INTERNAL_SIGNALS = ["acknowledgedAt"];
export function publicRequestRecord(request) {
  const copy = structuredClone(request);
  for (const key of INTERNAL_SIGNALS) delete copy[key];
  return copy;
}
