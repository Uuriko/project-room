// K013: recurring rooms. Pure recurrence tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createRecurrence, RecurrenceError, FREQUENCIES } from "../server/recurring-rooms.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RecurrenceError && error.code === code);

test("create/nextOccurrence/markCreated lifecycle", () => {
  const recurrence = createRecurrence();
  assert.deepEqual(FREQUENCIES, ["daily", "weekly"]);
  const schedule = recurrence.create({ templateId: "standup", frequency: "weekly",
    values: { team: "Core" }, startAt: "2026-09-14T09:00:00Z" });
  assert.ok(schedule.scheduleId.startsWith("rec-"));
  assert.ok(Object.isFrozen(schedule));
  const next = recurrence.nextOccurrence(schedule.scheduleId, { now: "2026-09-16T00:00:00Z" });
  assert.equal(next, "2026-09-21T09:00:00.000Z"); // next Monday
  recurrence.markCreated(schedule.scheduleId, { occurrenceAt: next });
  assert.deepEqual(recurrence.createdOccurrences(schedule.scheduleId), [next]);
});
test("daily frequency advances by one day", () => {
  const recurrence = createRecurrence();
  const schedule = recurrence.create({ templateId: "standup", frequency: "daily",
    values: { team: "Core" }, startAt: "2026-09-16T09:00:00Z" });
  const next = recurrence.nextOccurrence(schedule.scheduleId, { now: "2026-09-16T10:00:00Z" });
  assert.equal(next, "2026-09-17T09:00:00.000Z");
});
test("malformed inputs are refused", () => {
  const recurrence = createRecurrence();
  throwsCode(() => recurrence.create({ templateId: "x", frequency: "hourly", values: {}, startAt: "2026-09-16T09:00:00Z" }), "invalid_recurrence");
  throwsCode(() => recurrence.nextOccurrence("ghost", { now: "2026-09-16T00:00:00Z" }), "invalid_recurrence");
});
