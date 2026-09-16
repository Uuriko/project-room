// Per-room analytics rollup (K030). A pure rollup engine: aggregate
// room events (messages, reactions, joins, work items) into per-room
// daily stats. Ties into the growth engine's event model. The module is
// pure and dependency-free. Frozen outputs; malformed inputs throw
// RollupError. Dashboard wiring is a later slice.
class RollupError extends Error { constructor(code, message) { super(message); this.name = "RollupError"; this.code = code; } }
const fail = (code, message) => { throw new RollupError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_rollup", message); };
const EVENT_TYPES = ["message", "reaction", "join", "leave", "work-item", "poll"];
// Roll up events into per-room per-day stats.
// events: [{ type, roomId, timestamp (ISO), userId }]
export function rollup({ events }) {
  check(Array.isArray(events), "events must be an array");
  const rooms = new Map();
  for (const e of events) {
    check(e !== null && typeof e === "object", "every event must be an object");
    check(EVENT_TYPES.includes(e.type), `type must be one of ${EVENT_TYPES.join(", ")}`);
    check(typeof e.roomId === "string" && e.roomId.length > 0, "roomId must be non-empty");
    check(typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)),
      "timestamp must be a valid ISO string");
    const day = e.timestamp.slice(0, 10); // YYYY-MM-DD
    const key = `${e.roomId}|${day}`;
    if (!rooms.has(key)) {
      rooms.set(key, { roomId: e.roomId, day, messages: 0, reactions: 0,
        joins: 0, leaves: 0, workItems: 0, polls: 0, activeUsers: new Set() });
    }
    const stat = rooms.get(key);
    if (e.type === "message") stat.messages++;
    else if (e.type === "reaction") stat.reactions++;
    else if (e.type === "join") stat.joins++;
    else if (e.type === "leave") stat.leaves++;
    else if (e.type === "work-item") stat.workItems++;
    else if (e.type === "poll") stat.polls++;
    if (e.userId) stat.activeUsers.add(e.userId);
  }
  const result = [...rooms.values()].map(s => Object.freeze({
    roomId: s.roomId, day: s.day, messages: s.messages, reactions: s.reactions,
    joins: s.joins, leaves: s.leaves, workItems: s.workItems, polls: s.polls,
    activeUsers: s.activeUsers.size }));
  result.sort((a, b) => a.roomId.localeCompare(b.roomId) || a.day.localeCompare(b.day));
  return Object.freeze(result);
}
export { RollupError, EVENT_TYPES };
