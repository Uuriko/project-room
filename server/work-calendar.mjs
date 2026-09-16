// Calendar view of dated work (K005). A pure date-grouping module: given
// work items with due dates (and optional start dates), group them by
// calendar day, flag overdue items, and list what's due in a window.
// Dates are ISO strings; "today" is injectable for tests. The module is
// pure and dependency-free. Frozen outputs; malformed inputs throw
// CalendarError. UI rendering is a later slice.
class CalendarError extends Error { constructor(code, message) { super(message); this.name = "CalendarError"; this.code = code; } }
const fail = (code, message) => { throw new CalendarError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_calendar", message); };

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKeyOf = ms => new Date(ms).toISOString().slice(0, 10);
const checkItem = (item, index) => {
  check(item !== null && typeof item === "object", `item ${index} must be an object`);
  check(typeof item.id === "string" && item.id.length > 0, `item ${index} needs an id`);
  check(typeof item.dueAt === "string" && !Number.isNaN(new Date(item.dueAt).getTime()),
    `item ${index} needs a parseable dueAt`);
  check(item.startAt === undefined || (typeof item.startAt === "string" && !Number.isNaN(new Date(item.startAt).getTime())),
    `item ${index} startAt must be parseable if given`);
  check(item.title === undefined || typeof item.title === "string", `item ${index} title must be a string if given`);
  return Object.freeze({ id: item.id, title: item.title ?? item.id,
    dueAt: item.dueAt, startAt: item.startAt ?? null });
};
// Group items by due-date day. Returns { days: { "YYYY-MM-DD": [items] }, overdue: [items] }.
export function groupByDay(rawItems, { today } = {}) {
  check(Array.isArray(rawItems), "items must be an array");
  const nowMs = today === undefined || today === null ? Date.now() : new Date(today).getTime();
  check(!Number.isNaN(nowMs), "today must be parseable");
  const todayKey = dayKeyOf(nowMs);
  const items = rawItems.map(checkItem);
  const days = {};
  const overdue = [];
  for (const item of items) {
    const dueMs = new Date(item.dueAt).getTime();
    const key = dayKeyOf(dueMs);
    (days[key] ??= []).push(item);
    if (key < todayKey) overdue.push(item);
  }
  for (const key of Object.keys(days)) {
    days[key].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    days[key] = Object.freeze(days[key]);
  }
  overdue.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  return Object.freeze({ days: Object.freeze(days), overdue: Object.freeze(overdue), today: todayKey });
}
// Items due within the next `daysAhead` days (inclusive), excluding overdue.
export function dueSoon(rawItems, { daysAhead, today } = {}) {
  check(Number.isInteger(daysAhead) && daysAhead >= 0, "daysAhead must be a non-negative integer");
  const { days, today: todayKey } = groupByDay(rawItems, { today });
  const cutoff = dayKeyOf(new Date(todayKey + "T00:00:00Z").getTime() + daysAhead * DAY_MS);
  const results = [];
  for (const key of Object.keys(days).sort()) {
    if (key >= todayKey && key <= cutoff) results.push(...days[key]);
  }
  return Object.freeze(results);
}
export { CalendarError };
