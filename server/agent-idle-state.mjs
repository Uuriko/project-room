// Idle state and delivery choice for Room members (docs/IDLE-TO-USEFUL-WORK.md).
//
// Pure functions over facts the Room already records (heartbeat hosts, push
// configs, wake polls, listener leases, wake signals, claims, requests). No
// storage, no I/O, no clock reads: callers pass `nowMs`. Producers such as the
// idle nudge (#6387) and scoped idle pickup (#6441) can share one answer to
// "is this member idle, can it hear us, and how?" plus one loop/cost guard.
//
// Only the guard in nudgeAllowed is a hard limit (runaway wakes cost model and
// API spend and can loop an agent). Everything else is guidance and tunable.

export const IDLE_STATES = Object.freeze(["working", "idle_reachable", "idle_unreachable", "sleeping", "human"]);
export const AGENT_KINDS = Object.freeze(["acp", "webhook", "stream", "poller", "cloud", "human", "unknown"]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Same floor as agent-heartbeats' reachability window: max(180s, cadence * 1.5).
const MIN_REACH_MS = 180_000;

export const DEFAULT_NUDGE_LIMITS = Object.freeze({
  windowMs: 20 * MINUTE,
  minWindowMs: 15 * MINUTE,
  perMemberPerHour: 3,
  perRoomPerHour: 12,
  backoffCapMs: 4 * HOUR,
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const latest = values => values.filter(finite).reduce((max, value) => Math.max(max, value), -Infinity);

function reachWindowMs(cadenceSeconds) {
  return finite(cadenceSeconds) && cadenceSeconds > 0
    ? Math.max(MIN_REACH_MS, cadenceSeconds * 1500) : MIN_REACH_MS;
}

// Which channels are live right now. The agent kind is inferred from what
// actually works, not from what the member says it is.
export function liveChannels(facts = {}, nowMs) {
  const window = reachWindowMs(facts.cadenceSeconds);
  const fresh = at => finite(at) && nowMs - at <= window;
  const channels = [];
  if (finite(facts.listenerLeaseExpiresAt) && facts.listenerLeaseExpiresAt > nowMs) channels.push("acp");
  if ((facts.wakeUrl || facts.pushUrl) && !facts.pushSuspended) channels.push("webhook");
  if (fresh(facts.streamSeenAt)) channels.push("stream");
  if (fresh(facts.lastPolledAt) || fresh(facts.lastSeenAt)) channels.push("poller");
  return channels;
}

export function inferKind(facts = {}, nowMs) {
  if (facts.memberKind === "human") return "human";
  const live = liveChannels(facts, nowMs);
  // Preference: the channel that starts a turn fastest and most reliably.
  for (const kind of ["acp", "webhook", "stream", "poller"]) if (live.includes(kind)) return kind;
  if (facts.cloudLauncher) return "cloud";
  // Fall back to the most recent configured channel, even if it is not live
  // now, so an owner line can say which channel went quiet.
  if (finite(facts.listenerLeaseExpiresAt)) return "acp";
  if (facts.wakeUrl || facts.pushUrl) return "webhook";
  if (finite(facts.streamSeenAt)) return "stream";
  if (finite(facts.lastPolledAt) || finite(facts.lastSeenAt)) return "poller";
  return "unknown";
}

function inFlight(facts, nowMs) {
  const reasons = [];
  const claims = Array.isArray(facts.openClaims) ? facts.openClaims : [];
  if (claims.some(claim => !finite(claim?.leaseExpiresAt) || claim.leaseExpiresAt > nowMs)) reasons.push("open_claim");
  if ((facts.openRequestsToMember ?? 0) > 0) reasons.push("open_request");
  if ((facts.unackedWakes ?? 0) > 0) reasons.push("unacked_wake");
  return reasons;
}

// Derived per-member idle state. `idleMinutes` is coarse (whole minutes) and
// is null while working; callers must not expose exact activity timestamps.
export function classifyMember(facts = {}, nowMs) {
  if (!finite(nowMs)) throw new TypeError("nowMs must be a finite millisecond timestamp");
  const kind = inferKind(facts, nowMs);
  if (kind === "human") return Object.freeze({ state: "human", kind, reasons: Object.freeze(["human_member"]), idleMinutes: null, channels: Object.freeze([]) });
  const channels = liveChannels(facts, nowMs);
  if (facts.paused || facts.memberPaused || facts.outsideSchedule) {
    return Object.freeze({ state: "sleeping", kind, reasons: Object.freeze([facts.outsideSchedule ? "outside_schedule" : "paused"]), idleMinutes: null, channels: Object.freeze(channels) });
  }
  const busy = inFlight(facts, nowMs);
  if (busy.length) return Object.freeze({ state: "working", kind, reasons: Object.freeze(busy), idleMinutes: null, channels: Object.freeze(channels) });
  const since = latest([facts.lastClaimActivityAt, facts.lastAnsweredAt, facts.lastAckedWakeAt]);
  const idleMinutes = since === -Infinity ? null : Math.max(0, Math.floor((nowMs - since) / MINUTE));
  const reasons = [];
  if (!channels.length) {
    if (facts.pushSuspended) reasons.push("webhook_suspended");
    else if (finite(facts.listenerLeaseExpiresAt)) reasons.push("listener_expired");
    else if (kind === "cloud") reasons.push("launch_required");
    else reasons.push("no_live_channel");
  }
  return Object.freeze({
    state: channels.length ? "idle_reachable" : "idle_unreachable",
    kind, reasons: Object.freeze(reasons), idleMinutes, channels: Object.freeze(channels),
  });
}

// How to deliver one useful item to a member in this state. `channel: null`
// means do not wake; `ownerLine: true` means surface it to an owner once.
export function deliveryFor(classification) {
  const { state, kind } = classification ?? {};
  if (state === "working" || state === "sleeping" || state === "human") {
    return Object.freeze({ channel: null, ownerLine: false, reason: state });
  }
  if (state === "idle_unreachable") {
    return Object.freeze({ channel: null, ownerLine: true, reason: kind === "cloud" ? "launch_is_owner_spend_decision" : "no_live_channel" });
  }
  if (state !== "idle_reachable") return Object.freeze({ channel: null, ownerLine: false, reason: "unknown_state" });
  switch (kind) {
    case "acp": return Object.freeze({ channel: "ready_work_wake", ownerLine: false, reason: "listener_starts_turn" });
    case "webhook": return Object.freeze({ channel: "wake_signal_webhook", ownerLine: false, reason: "signed_webhook_dispatch" });
    case "stream": return Object.freeze({ channel: "formal_request", ownerLine: false, reason: "stream_handoff_wakes_on_request" });
    case "poller": return Object.freeze({ channel: "wake_signal", ownerLine: false, reason: "picked_up_on_next_poll" });
    default: return Object.freeze({ channel: null, ownerLine: true, reason: "unknown_kind" });
  }
}

// The one hard limit: runaway nudges. `history` is the nudges already sent
// in this room ({ memberId, itemId, at, outcome? }), newest last or any order.
// outcome "acked_unclaimed" triggers a doubling backoff for that member+item.
export function nudgeAllowed({ memberId, itemId, classification, history = [], nowMs, limits = {} } = {}) {
  const l = { ...DEFAULT_NUDGE_LIMITS, ...limits };
  const windowMs = Math.max(l.minWindowMs, finite(l.windowMs) ? l.windowMs : DEFAULT_NUDGE_LIMITS.windowMs);
  if (!finite(nowMs)) throw new TypeError("nowMs must be a finite millisecond timestamp");
  if (!memberId || !itemId) return Object.freeze({ allowed: false, reason: "missing_target" });
  if (classification && classification.state !== "idle_reachable") {
    return Object.freeze({ allowed: false, reason: `state_${classification.state}` });
  }
  const valid = (Array.isArray(history) ? history : []).filter(entry => entry && finite(entry.at) && entry.at <= nowMs);
  const mine = valid.filter(entry => entry.memberId === memberId);
  const lastMine = latest(mine.map(entry => entry.at));
  if (lastMine !== -Infinity && nowMs - lastMine < windowMs) {
    return Object.freeze({ allowed: false, reason: "member_window", retryAt: lastMine + windowMs });
  }
  const hourAgo = nowMs - HOUR;
  if (mine.filter(entry => entry.at > hourAgo).length >= l.perMemberPerHour) return Object.freeze({ allowed: false, reason: "member_hourly_cap" });
  if (valid.filter(entry => entry.at > hourAgo).length >= l.perRoomPerHour) return Object.freeze({ allowed: false, reason: "room_hourly_cap" });
  const ignored = mine.filter(entry => entry.itemId === itemId && entry.outcome === "acked_unclaimed")
    .sort((a, b) => a.at - b.at);
  if (ignored.length) {
    const backoff = Math.min(l.backoffCapMs, windowMs * 2 ** ignored.length);
    const until = ignored.at(-1).at + backoff;
    if (nowMs < until) return Object.freeze({ allowed: false, reason: "item_backoff", retryAt: until });
  }
  return Object.freeze({ allowed: true, reason: "ok" });
}
