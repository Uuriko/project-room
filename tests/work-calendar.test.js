// K005: calendar view of dated work. Pure grouping tests.
import test from "node:test";
import assert from "node:assert/strict";
import { groupByDay, dueSoon, CalendarError } from "../server/work-calendar.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof CalendarError && error.code === code);
const TODAY = "2026-09-16T12:00:00Z";

test("groupByDay groups by day and flags overdue", () => {
  const grouped = groupByDay([
    { id: "a", dueAt: "2026-09-16T18:00:00Z", title: "Today task" },
    { id: "b", dueAt: "2026-09-15T09:00:00Z" },
    { id: "c", dueAt: "2026-09-17T09:00:00Z" },
  ], { today: TODAY });
  assert.equal(grouped.today, "2026-09-16");
  assert.deepEqual(Object.keys(grouped.days).sort(), ["2026-09-15", "2026-09-16", "2026-09-17"]);
  assert.deepEqual(grouped.overdue.map(i => i.id), ["b"]);
  assert.ok(Object.isFrozen(grouped) && Object.isFrozen(grouped.days));
});
test("dueSoon lists items in the window, excluding overdue", () => {
  const items = [
    { id: "past", dueAt: "2026-09-15T09:00:00Z" },
    { id: "today", dueAt: "2026-09-16T09:00:00Z" },
    { id: "soon", dueAt: "2026-09-18T09:00:00Z" },
    { id: "later", dueAt: "2026-09-25T09:00:00Z" },
  ];
  assert.deepEqual(dueSoon(items, { daysAhead: 2, today: TODAY }).map(i => i.id), ["today", "soon"]);
  assert.deepEqual(dueSoon(items, { daysAhead: 0, today: TODAY }).map(i => i.id), ["today"]);
});
test("malformed inputs are refused", () => {
  throwsCode(() => groupByDay("nope"), "invalid_calendar");
  throwsCode(() => groupByDay([{ id: "x", dueAt: "bad" }]), "invalid_calendar");
  throwsCode(() => dueSoon([], { daysAhead: -1 }), "invalid_calendar");
});
