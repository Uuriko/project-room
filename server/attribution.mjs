// Attribution ledger (B015). A pure append-only ledger: which agent did
// what, when, in which room. Entries record agentId, action, target, room,
// timestamp, and optional metadata. Query by agent, by action, by room, or
// by time range. The ledger is caller-owned (an array); this module is
// pure and dependency-free. Time is injectable for tests. Frozen outputs;
// malformed inputs throw AttributionError. Store/UI wiring is a later
// slice.
class AttributionError extends Error { constructor(code, message) { super(message); this.name = "AttributionError"; this.code = code; } }
const fail = (code, message) => { throw new AttributionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_attribution", message); };

const entryOf = (value, index) => {
  check(value !== null && typeof value === "object", `entry ${index} must be an object`);
  check(typeof value.agentId === "string" && value.agentId.length > 0, `entry ${index} needs an agentId`);
  check(typeof value.action === "string" && value.action.length > 0, `entry ${index} needs an action`);
  check(value.at === null || (typeof value.at === "string" && !Number.isNaN(new Date(value.at).getTime())),
    `entry ${index} needs a parseable at or null`);
  check(value.room === undefined || (typeof value.room === "string" && value.room.length > 0),
    `entry ${index} room must be a non-empty string if given`);
  check(value.target === undefined || (typeof value.target === "string" && value.target.length > 0),
    `entry ${index} target must be a non-empty string if given`);
  return Object.freeze({ agentId: value.agentId, action: value.action,
    room: value.room ?? null, target: value.target ?? null, at: value.at,
    metadata: value.metadata === undefined ? null : Object.freeze({ ...value.metadata }) });
};
// Create a ledger. store is a caller-owned array.
export function createLedger({ store } = {}) {
  check(store === undefined || Array.isArray(store), "store must be an array if given");
  const entries = store ?? [];
  // Record an action. Returns the frozen entry. `at` is caller-supplied
  // (ISO string) or null — no wall-clock reads, the ledger is pure.
  const record = ({ agentId, action, room, target, metadata, at } = {}) => {
    check(at === undefined || at === null || (typeof at === "string" && at.length > 0),
      "at must be a non-empty string if given");
    const entry = entryOf({ agentId, action, room, target, metadata, at: at ?? null }, entries.length);
    entries.push(entry);
    return entry;
  };
  // Query entries. All filters are optional; at most 10000 results.
  const query = ({ agentId, action, room, since, until, limit } = {}) => {
    check(agentId === undefined || typeof agentId === "string", "agentId filter must be a string");
    check(action === undefined || typeof action === "string", "action filter must be a string");
    check(room === undefined || typeof room === "string", "room filter must be a string");
    const sinceMs = since === undefined ? -Infinity : new Date(since).getTime();
    const untilMs = until === undefined ? Infinity : new Date(until).getTime();
    check(!Number.isNaN(sinceMs) && !Number.isNaN(untilMs), "since/until must be parseable");
    const max = limit === undefined ? 10000 : limit;
    check(Number.isInteger(max) && max >= 1 && max <= 10000, "limit must be 1-10000");
    const results = entries.filter(e =>
      (agentId === undefined || e.agentId === agentId) &&
      (action === undefined || e.action === action) &&
      (room === undefined || e.room === room) &&
      new Date(e.at).getTime() >= sinceMs && new Date(e.at).getTime() <= untilMs
    ).slice(0, max);
    return Object.freeze(results);
  };
  // Count actions per agent (optionally filtered by action/room).
  const countByAgent = ({ action, room } = {}) =>
    Object.freeze(query({ action, room }).reduce((counts, e) => {
      counts[e.agentId] = (counts[e.agentId] ?? 0) + 1;
      return counts;
    }, {}));
  return Object.freeze({ record, query, countByAgent, size: () => entries.length });
}
export { AttributionError };
