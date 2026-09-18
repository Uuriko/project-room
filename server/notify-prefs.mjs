// Notification preferences (K019) + quiet hours and per-connection notify
// schedules. A pure preference manager: per-user notification settings at
// global, per-room, and per-thread granularity, plus per-user quiet hours
// and per-connection (Telegram/email/etc) notify schedules.
//
// Resolution order: thread > room > global > default. Levels: "all",
// "mentions", "muted". Quiet hours are a half-open local window [start, end)
// expressed as "HH:MM" with an IANA tz; when end <= start the window wraps
// overnight, and start === end disables the window. All state is caller-owned
// (a Map); the module is pure and dependency-free. Frozen outputs;
// malformed inputs throw NotifyError. Preferences UI wiring is a later slice.
class NotifyError extends Error { constructor(code, message) { super(message); this.name = "NotifyError"; this.code = code; } }
const fail = (code, message) => { throw new NotifyError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_notify", message); };
const LEVELS = ["all", "mentions", "muted"];
const DEFAULT_LEVEL = "mentions";
const BATCHINGS = ["immediate", "digest"];
const HM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// True when `at` (ms epoch) falls inside the quiet-hours window. Half-open
// [start, end); overnight windows (end <= start) wrap past midnight; a
// zero-length window is off. Pure; tz resolved with the built-in Intl API.
export function isQuietAt(quietHours, at = Date.now()) {
  check(quietHours !== null && typeof quietHours === "object" && !Array.isArray(quietHours), "quietHours must be an object");
  check(typeof at === "number" && Number.isFinite(at), "at must be a finite ms-epoch time");
  const { start, end, tz = "UTC" } = quietHours;
  const hmToMinutes = (value, field) => {
    check(typeof value === "string" && HM_RE.test(value), `quietHours.${field} must be "HH:MM" (24h)`);
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  const startMin = hmToMinutes(start, "start");
  const endMin = hmToMinutes(end, "end");
  check(typeof tz === "string" && tz.length > 0, "quietHours.tz must be an IANA zone name string");
  let minutes;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at));
    const hour = Number(parts.find(p => p.type === "hour").value) % 24;
    const minute = Number(parts.find(p => p.type === "minute").value);
    minutes = hour * 60 + minute;
  } catch {
    fail("invalid_notify", `quietHours.tz is not a known IANA zone: ${tz}`);
  }
  if (startMin === endMin) return false; // zero-length window = off
  if (endMin > startMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin; // overnight wrap
}
const normalizeQuietHours = value => {
  if (value === null || value === undefined) return null;
  check(typeof value === "object" && !Array.isArray(value), "quietHours must be an object or null");
  const { start, end, tz } = value;
  const hmToMinutes = (field, v) => { check(typeof v === "string" && HM_RE.test(v), `quietHours.${field} must be "HH:MM" (24h)`); };
  hmToMinutes("start", start); hmToMinutes("end", end);
  const zone = tz === undefined ? "UTC" : tz;
  check(typeof zone === "string" && zone.length > 0, "quietHours.tz must be an IANA zone name string");
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); }
  catch { fail("invalid_notify", `quietHours.tz is not a known IANA zone: ${zone}`); }
  return Object.freeze({ start, end, tz: zone });
};
// Create a notification-preference manager. store is a caller-owned Map (userId -> prefs).
export function createNotifyPrefs({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const users = store ?? new Map();
  const prefsFor = userId => {
    check(typeof userId === "string" && userId.length > 0, "userId must be a non-empty string");
    if (!users.has(userId)) {
      users.set(userId, { global: null, rooms: new Map(), threads: new Map(),
        quietHours: null, connections: new Map() });
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
  // Set the user's quiet-hours window. start === end disables it.
  const setQuietHours = (userId, { start, end, tz }) => {
    const normalized = normalizeQuietHours({ start, end, tz });
    prefsFor(userId).quietHours = normalized;
    return Object.freeze({ userId, scope: "quietHours", quietHours: normalized });
  };
  // Clear the user's quiet-hours window (equivalent to start === end).
  const clearQuietHours = userId => {
    prefsFor(userId).quietHours = null;
    return Object.freeze({ userId, scope: "quietHours", quietHours: null });
  };
  // Read the user's quiet-hours window (null when unset).
  const quietHoursFor = userId => prefsFor(userId).quietHours;
  // Set a per-connection notify schedule: channel ("telegram"/"email"/...),
  // batching ("immediate" or "digest"), and an optional quietHours override
  // that wins over the user's window for this connection.
  const setConnection = (userId, { connectionId, channel, batching = "immediate", quietHours } = {}) => {
    check(typeof connectionId === "string" && connectionId.length > 0 && connectionId.length <= 256,
      "connectionId must be a 1..256 character string");
    check(typeof channel === "string" && channel.length > 0 && channel.length <= 128,
      "channel must be a 1..128 character string");
    check(BATCHINGS.includes(batching), `batching must be one of ${BATCHINGS.join(", ")}`);
    const normalized = normalizeQuietHours(quietHours === undefined ? null : quietHours);
    prefsFor(userId).connections.set(connectionId, Object.freeze({ connectionId, channel, batching, quietHours: normalized }));
    return Object.freeze({ userId, scope: "connection", connectionId, channel, batching, quietHours: normalized });
  };
  // Remove a per-connection schedule.
  const removeConnection = (userId, connectionId) => {
    const prefs = prefsFor(userId);
    check(typeof connectionId === "string" && connectionId.length > 0, "connectionId must be a non-empty string");
    check(prefs.connections.has(connectionId), `unknown connection "${connectionId}"`);
    const removed = prefs.connections.get(connectionId);
    prefs.connections.delete(connectionId);
    return removed;
  };
  // Read a per-connection schedule (null when unset).
  const connectionFor = (userId, connectionId) => {
    const prefs = prefsFor(userId);
    return prefs.connections.get(connectionId) ?? null;
  };
  // Export the prefs a notify decision ran on as a plain JSON-safe record, and
  // restore one onto a fresh manager. The inbox import path journals the
  // snapshot with each imported message so the journal replay recomputes the
  // recorded decision from the recorded inputs — the decision stays
  // replay-deterministic even after the owner edits their prefs.
  const snapshot = userId => {
    const prefs = prefsFor(userId);
    const windowOf = window => window === null ? null : Object.freeze({ ...window });
    return Object.freeze({ global: prefs.global,
      rooms: Object.freeze({ ...Object.fromEntries(prefs.rooms) }),
      threads: Object.freeze({ ...Object.fromEntries(prefs.threads) }),
      quietHours: windowOf(prefs.quietHours),
      connections: Object.freeze(Object.fromEntries([...prefs.connections].map(([id, connection]) =>
        [id, Object.freeze({ connectionId: id, channel: connection.channel, batching: connection.batching,
          quietHours: windowOf(connection.quietHours) })]))) });
  };
  const restore = (userId, value) => {
    check(value !== null && typeof value === "object" && !Array.isArray(value), "prefs snapshot must be an object");
    users.delete(userId);
    if (value.global !== undefined && value.global !== null) setGlobal(userId, { level: value.global });
    for (const [roomId, level] of Object.entries(value.rooms ?? {})) setRoom(userId, { roomId, level });
    for (const [threadId, level] of Object.entries(value.threads ?? {})) setThread(userId, { threadId, level });
    if (value.quietHours !== undefined && value.quietHours !== null) setQuietHours(userId, value.quietHours);
    for (const [connectionId, connection] of Object.entries(value.connections ?? {}))
      setConnection(userId, { connectionId, channel: connection.channel, batching: connection.batching,
        quietHours: connection.quietHours ?? null });
    return snapshot(userId);
  };
  // Resolve the effective level for a thread in a room.
  const resolve = (userId, { roomId, threadId }) => {
    const prefs = prefsFor(userId);
    if (threadId && prefs.threads.has(threadId)) return prefs.threads.get(threadId);
    if (roomId && prefs.rooms.has(roomId)) return prefs.rooms.get(roomId);
    if (prefs.global) return prefs.global;
    return DEFAULT_LEVEL;
  };
  // Decide how one notification should be handled right now:
  //   deliver — push it immediately (urgent SLA-breach mail is never held)
  //   hold    — quiet hours or per-connection digest batching: it joins the
  //             morning digest instead of pinging per message
  //   muted   — the user's level says nothing arrives
  // urgent marks SLA-breach notifications, which override quiet hours.
  const decideNotification = (userId, { connectionId = null, urgent = false, at = Date.now() } = {}) => {
    const prefs = prefsFor(userId);
    check(connectionId === null || (typeof connectionId === "string" && connectionId.length > 0 && connectionId.length <= 256),
      "connectionId must be a short string when given");
    check(typeof urgent === "boolean", "urgent must be a boolean");
    check(typeof at === "number" && Number.isFinite(at), "at must be a finite ms-epoch time");
    const connection = connectionId ? prefs.connections.get(connectionId) ?? null : null;
    const level = prefs.global ?? DEFAULT_LEVEL;
    if (level === "muted") return Object.freeze({ decision: "muted", reason: "user muted all notifications" });
    if (urgent) return Object.freeze({ decision: "deliver",
      reason: "urgent notification (SLA breach) overrides quiet hours and batching" });
    const window = connection?.quietHours ?? prefs.quietHours;
    if (window && isQuietAt(window, at)) return Object.freeze({ decision: "hold",
      reason: `quiet hours (${window.start}-${window.end}${window.tz === "UTC" ? "" : " " + window.tz}): batched into the morning digest` });
    if (connection && connection.batching === "digest") return Object.freeze({ decision: "hold",
      reason: `connection "${connectionId}" uses digest batching (${connection.channel})` });
    return Object.freeze({ decision: "deliver", reason: "outside quiet hours; immediate delivery" });
  };
  return Object.freeze({ setGlobal, setRoom, setThread, resolve, LEVELS: Object.freeze([...LEVELS]),
    setQuietHours, clearQuietHours, quietHoursFor,
    setConnection, removeConnection, connectionFor, snapshot, restore, decideNotification,
    BATCHINGS: Object.freeze([...BATCHINGS]) });
}
export { NotifyError };
