// Presentation of observations, never an authorization or session-lease rule.
export const PRESENCE_LIVE_WINDOW_MS = 5 * 60 * 1000;
// Retained export for callers of the previous derivation; commands do not prove work.
export const PRESENCE_WORKING_WINDOW_MS = 5 * 60 * 1000;
export const PRESENCE_IDLE_WINDOW_MS = 60 * 60 * 1000;
export const PRESENCE_UNREACHABLE_AFTER_MS = 60 * 60 * 1000;

const within = (at, now, windowMs) =>
  Number.isFinite(at) && Number.isFinite(now) && now - at >= 0 && now - at <= windowMs;

// Times are epoch milliseconds. hasActiveSession means fresh processing/active
// execution, not assignment or a suspended reservation. Canonical host status
// already accounts for every registered host's declared heartbeat cadence.
export function presenceState({
  kind, hasActiveSession = false, watching = false, hostStatus = null,
  hostLastSeenAt = null, lastCommandAt = null, lastSeenAt = null, now = Date.now(),
}) {
  if (hasActiveSession) return "working";
  if (watching) return "listening";
  if (kind !== "agent") {
    return within(lastCommandAt, now, PRESENCE_LIVE_WINDOW_MS) ? "listening" : "idle";
  }
  const validHostObservation = Number.isFinite(hostLastSeenAt)
    && Number.isFinite(now) && hostLastSeenAt <= now;
  if (validHostObservation && hostStatus === "online") return "listening";
  if (validHostObservation && hostStatus === "offline") return "unreachable";
  if (within(lastCommandAt, now, PRESENCE_IDLE_WINDOW_MS)
    || within(lastSeenAt, now, PRESENCE_IDLE_WINDOW_MS)) return "idle";
  return "unknown";
}
