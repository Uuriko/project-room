// Estimates + time tracking (K003). A pure time tracker for work items:
// set an estimate (in minutes), start/stop timers, and log time entries.
// Summaries report estimated vs actual per item, plus a rollup across
// items. All state is caller-owned (a Map); time is injectable for tests.
// The module is pure and dependency-free. Frozen outputs; malformed
// inputs throw TimeTrackError. Store/UI wiring is a later slice.
class TimeTrackError extends Error { constructor(code, message) { super(message); this.name = "TimeTrackError"; this.code = code; } }
const fail = (code, message) => { throw new TimeTrackError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_time_track", message); };
// Create a tracker. store is a caller-owned Map (itemId -> { estimateMin, entries: [], activeStart }).
export function createTimeTracker({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const items = store ?? new Map();
  const nowMs = now => {
    const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
    check(!Number.isNaN(at), "now must be parseable");
    return at;
  };
  const checkId = id => check(typeof id === "string" && id.length > 0, "itemId must be a non-empty string");
  const get = id => { checkId(id); check(items.has(id), `unknown item "${id}"`); return items.get(id); };
  // Set (or clear) the estimate in minutes.
  const setEstimate = (id, minutes) => {
    checkId(id);
    check(minutes === null || (Number.isFinite(minutes) && minutes >= 0), "estimate must be non-negative minutes or null");
    const current = items.get(id) ?? { estimateMin: null, entries: [], activeStart: null };
    items.set(id, { ...current, estimateMin: minutes });
  };
  // Start a timer. Refuses if one is already running.
  const start = (id, { now, note } = {}) => {
    const current = get(id);
    check(current.activeStart === null, `timer already running for "${id}"`);
    check(note === undefined || (typeof note === "string" && note.length <= 500), "note must be ≤500 chars");
    items.set(id, { ...current, activeStart: { at: new Date(nowMs(now)).toISOString(), note: note ?? null } });
  };
  // Stop the timer and log an entry. Returns the logged entry.
  const stop = (id, { now } = {}) => {
    const current = get(id);
    check(current.activeStart !== null, `no timer running for "${id}"`);
    const at = nowMs(now);
    const startedAt = new Date(current.activeStart.at).getTime();
    check(at >= startedAt, "stop time cannot be before start time");
    const entry = Object.freeze({ startedAt: current.activeStart.at,
      endedAt: new Date(at).toISOString(),
      minutes: Math.round((at - startedAt) / 6000) / 10,
      note: current.activeStart.note });
    items.set(id, { ...current, activeStart: null, entries: [...current.entries, entry] });
    return entry;
  };
  // Summary for one item: estimate vs actual.
  const summary = id => {
    const current = get(id);
    const actualMin = Math.round(current.entries.reduce((t, e) => t + e.minutes, 0) * 10) / 10;
    return Object.freeze({ itemId: id, estimateMin: current.estimateMin, actualMin,
      entryCount: current.entries.length, timerRunning: current.activeStart !== null,
      overEstimate: current.estimateMin !== null && actualMin > current.estimateMin });
  };
  // Rollup across all items.
  const rollup = () => {
    let estimated = 0, actual = 0, running = 0;
    for (const id of items.keys()) {
      const s = summary(id);
      if (s.estimateMin !== null) estimated += s.estimateMin;
      actual += s.actualMin;
      if (s.timerRunning) running += 1;
    }
    return Object.freeze({ items: items.size, estimatedMin: Math.round(estimated * 10) / 10,
      actualMin: Math.round(actual * 10) / 10, timersRunning: running });
  };
  return Object.freeze({ setEstimate, start, stop, summary, rollup, size: () => items.size });
}
export { TimeTrackError };
