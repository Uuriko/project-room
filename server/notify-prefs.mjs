// Notification preferences (K019). A pure preference manager: per-user
// notification settings at global, per-room, and per-thread granularity.
// Resolution order: thread > room > global > default. Levels: "all",
// "mentions", "muted". All state is caller-owned (a Map); the module is
// pure and dependency-free. Frozen outputs; malformed inputs throw
// NotifyError. Preferences UI wiring is a later slice.
class NotifyError extends Error { constructor(code, message) { super(message); this.name = "NotifyError"; this.code = code; } }
const fail = (code, message) => { throw new NotifyError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_notify", message); };
const LEVELS = ["all", "mentions", "muted"];
const DEFAULT_LEVEL = "mentions";
// Create a notification-preference manager. store is a caller-owned Map (userId -> prefs).
export function createNotifyPrefs({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const users = store ?? new Map();
  const prefsFor = userId => {
    check(typeof userId === "string" && userId.length > 0, "userId must be a non-empty string");
    if (!users.has(userId)) {
      users.set(userId, { global: null, rooms: new Map(), threads: new Map() });
    }
    return users.get(userId);
  };
  const checkLevel = level => {
    check(LEVELS.includes(level), `level must be one of ${LEVELS.join(", ")}`);
  };
  // Set global default.
  const setGlobal = (userId, { level }) => {
    checkLevel(level);
    prefsFor(userId).global = level;
    return Object.freeze({ userId, scope: "global", level });
  };
  // Set per-room level.
  const setRoom = (userId, { roomId, level }) => {
    checkLevel(level);
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    prefsFor(userId).rooms.set(roomId, level);
    return Object.freeze({ userId, scope: "room", roomId, level });
  };
  // Set per-thread level.
  const setThread = (userId, { threadId, level }) => {
    checkLevel(level);
    check(typeof threadId === "string" && threadId.length > 0, "threadId must be a non-empty string");
    prefsFor(userId).threads.set(threadId, level);
    return Object.freeze({ userId, scope: "thread", threadId, level });
  };
  // Resolve the effective level for a thread in a room.
  const resolve = (userId, { roomId, threadId }) => {
    const prefs = prefsFor(userId);
    if (threadId && prefs.threads.has(threadId)) return prefs.threads.get(threadId);
    if (roomId && prefs.rooms.has(roomId)) return prefs.rooms.get(roomId);
    if (prefs.global) return prefs.global;
    return DEFAULT_LEVEL;
  };
  return Object.freeze({ setGlobal, setRoom, setThread, resolve, LEVELS: Object.freeze([...LEVELS]) });
}
export { NotifyError };
