// Agent presence (B009). A pure presence tracker: agents report heartbeat
// with a status (online / working / paused / offline). The tracker keeps
// the last-seen timestamp per agent, derives an effective status (an agent
// that stops heartbeating goes stale → offline after a timeout), and lists
// who's currently visible in a room. All state is caller-owned (a Map);
// time is injectable for tests. Pure, dependency-free, deterministic;
// frozen outputs. Realtime broadcast wiring is a later slice.
const STATUSES = Object.freeze(["online", "working", "paused", "offline"]);
const DEFAULTS = Object.freeze({ staleAfterMs: 60000 });
class PresenceError extends Error { constructor(code, message) { super(message); this.name = "PresenceError"; this.code = code; } }
const fail = (code, message) => { throw new PresenceError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_presence", message); };
// Create a presence tracker. store is a caller-owned Map (agentId -> record).
export function createPresence({ staleAfterMs, store } = {}) {
  const staleMs = staleAfterMs ?? DEFAULTS.staleAfterMs;
  check(Number.isFinite(staleMs) && staleMs > 0, "staleAfterMs must be positive");
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const agents = store ?? new Map();
  const nowMs = now => {
    const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
    check(!Number.isNaN(at), "now must be parseable");
    return at;
  };
  // Record a heartbeat. Returns the agent's presence record.
  const heartbeat = (agentId, { status, room, now } = {}) => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    const s = status ?? "online";
    check(STATUSES.includes(s), `status must be one of ${STATUSES.join(", ")}`);
    check(room === undefined || (typeof room === "string" && room.length > 0), "room must be a non-empty string if given");
    const at = nowMs(now);
    const record = Object.freeze({ agentId, status: s, room: room ?? null,
      lastSeenAt: new Date(at).toISOString() });
    agents.set(agentId, record);
    return record;
  };
  // Effective status: reported status, or offline if stale.
  const effectiveStatus = (agentId, { now } = {}) => {
    check(typeof agentId === "string" && agents.has(agentId), `unknown agent "${agentId}"`);
    const record = agents.get(agentId);
    const at = nowMs(now);
    if (at - new Date(record.lastSeenAt).getTime() > staleMs) return "offline";
    return record.status;
  };
  // All agents currently visible in a room (not stale, not offline).
  const inRoom = (room, { now } = {}) => {
    check(typeof room === "string" && room.length > 0, "room must be a non-empty string");
    const at = nowMs(now);
    return Object.freeze([...agents.values()]
      .filter(r => r.room === room && at - new Date(r.lastSeenAt).getTime() <= staleMs && r.status !== "offline")
      .map(r => Object.freeze({ agentId: r.agentId, status: r.status, lastSeenAt: r.lastSeenAt })));
  };
  // Remove an agent entirely.
  const remove = agentId => {
    check(typeof agentId === "string" && agents.has(agentId), `unknown agent "${agentId}"`);
    agents.delete(agentId);
  };
  return Object.freeze({ heartbeat, effectiveStatus, inRoom, remove,
    size: () => agents.size, staleAfterMs: staleMs });
}
export { PresenceError, STATUSES, DEFAULTS };
