// Pure agent presence/working-state derivation (#660).
// Shared by server/store.mjs (authoritative, for the presence API and #658's
// mention lifecycle) and unit-tested without a DB. The browser rail prefers
// the server-provided `state` and falls back to its local derivation.
//
// States:
// - working: has an active work session (accepted or started), OR (agent-only)
//   a live host heartbeat plus a command in the working window.
// - listening: not working, but live — SSE watching, a host heartbeat inside
//   the live window, or (humans) a command inside the live window.
// - idle: none of the above, but seen inside the idle window.
// - unreachable: agent with a registered host whose last-seen is older than
//   the unreachable threshold. Humans never show unreachable (they show idle).

export const PRESENCE_LIVE_WINDOW_MS = 5 * 60 * 1000; // 5 min
export const PRESENCE_WORKING_WINDOW_MS = 5 * 60 * 1000; // 5 min
export const PRESENCE_IDLE_WINDOW_MS = 60 * 60 * 1000; // 60 min

// Default unreachable threshold; callers may pass a smaller one derived from
// 3x the host's expected heartbeat interval (see store.presence).
export const PRESENCE_UNREACHABLE_AFTER_MS = 60 * 60 * 1000; // 60 min

const within = (at, now, windowMs) =>
  Number.isFinite(at) && Number.isFinite(now) && now - at >= 0 && now - at <= windowMs;

// All timestamps are ms epoch (or null). hostStatus is "online" | "offline" |
// null (null = no registered host). Returns one of the four state strings.
export function presenceState({
  kind,
  hasActiveSession = false,
  watching = false,
  hostStatus = null,
  hostLastSeenAt = null,
  lastCommandAt = null,
  lastSeenAt = null,
  unreachableAfterMs = PRESENCE_UNREACHABLE_AFTER_MS,
  now = Date.now(),
}) {
  const isAgent = kind === "agent";

  // working: active session, or (agent-only) live host + recent command.
  if (hasActiveSession) return "working";
  if (isAgent && hostStatus === "online"
    && within(hostLastSeenAt, now, PRESENCE_WORKING_WINDOW_MS)
    && within(lastCommandAt, now, PRESENCE_WORKING_WINDOW_MS)) return "working";

  // listening: live but not working.
  if (watching) return "listening";
  if (within(hostLastSeenAt, now, PRESENCE_LIVE_WINDOW_MS)) return "listening";
  if (!isAgent && within(lastCommandAt, now, PRESENCE_LIVE_WINDOW_MS)) return "listening";

  // unreachable: agent with a registered host, gone longer than the threshold.
  // Humans never show unreachable.
  if (isAgent && hostStatus !== null) {
    const threshold = Number.isFinite(unreachableAfterMs) && unreachableAfterMs > 0
      ? unreachableAfterMs : PRESENCE_UNREACHABLE_AFTER_MS;
    if (!within(lastSeenAt, now, threshold)) return "unreachable";
  }

  // idle: seen recently enough, otherwise (no signal at all) also idle —
  // the rail must always render something, and "idle" is the honest default.
  return "idle";
}
