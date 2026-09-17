// Cross-agent 1:1 DM rooms (B013). A pure DM manager: create deterministic
// DM rooms between two agents (same pair always maps to the same room),
// list DMs for an agent, track unread counts. All state is caller-owned
// (a Map); the module is pure and dependency-free. Frozen outputs;
// malformed inputs throw DmError. Room/message wiring is a later slice.
class DmError extends Error { constructor(code, message) { super(message); this.name = "DmError"; this.code = code; } }
const fail = (code, message) => { throw new DmError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_dm", message); };
// Deterministic DM room id for a pair: sorted agent ids joined.
export function dmRoomId(agentA, agentB) {
  check(typeof agentA === "string" && agentA.length > 0, "agentA must be a non-empty string");
  check(typeof agentB === "string" && agentB.length > 0, "agentB must be a non-empty string");
  check(agentA !== agentB, "cannot DM yourself");
  const [first, second] = [agentA, agentB].sort();
  return `dm:${first}:${second}`;
}
// Create a DM manager. store is a caller-owned Map (roomId -> room).
export function createDmManager({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const rooms = store ?? new Map();
  // Get or create the DM room for a pair.
  const getOrCreate = (agentA, agentB) => {
    const roomId = dmRoomId(agentA, agentB);
    if (!rooms.has(roomId)) {
      const [first, second] = [agentA, agentB].sort();
      rooms.set(roomId, Object.freeze({ roomId, participants: Object.freeze([first, second]),
        unread: Object.freeze({ [first]: 0, [second]: 0 }) }));
    }
    return rooms.get(roomId);
  };
  // Record an incoming message (increments the recipient's unread).
  const recordMessage = (roomId, { from }) => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    check(rooms.has(roomId), `unknown DM room "${roomId}"`);
    check(typeof from === "string" && from.length > 0, "from must be a non-empty string");
    const room = rooms.get(roomId);
    check(room.participants.includes(from), `"${from}" is not in this DM`);
    const recipient = room.participants.find(p => p !== from);
    const updated = Object.freeze({ ...room,
      unread: Object.freeze({ ...room.unread, [recipient]: room.unread[recipient] + 1 }) });
    rooms.set(roomId, updated);
    return updated;
  };
  // Mark a DM as read for an agent.
  const markRead = (roomId, agentId) => {
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    check(rooms.has(roomId), `unknown DM room "${roomId}"`);
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    const room = rooms.get(roomId);
    check(room.participants.includes(agentId), `"${agentId}" is not in this DM`);
    const updated = Object.freeze({ ...room,
      unread: Object.freeze({ ...room.unread, [agentId]: 0 }) });
    rooms.set(roomId, updated);
    return updated;
  };
  // List all DM rooms for an agent.
  const forAgent = agentId => {
    check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
    return Object.freeze([...rooms.values()]
      .filter(r => r.participants.includes(agentId))
      .map(r => Object.freeze({ ...r })));
  };
  return Object.freeze({ getOrCreate, recordMessage, markRead, forAgent, size: () => rooms.size });
}
export { DmError };
