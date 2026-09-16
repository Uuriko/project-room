// Recurring rooms (K013). A pure recurrence scheduler: define recurring
// room schedules (daily/weekly with a template), compute upcoming
// occurrences, and track which have been created. All state is caller-
// owned (a Map); the module is pure and dependency-free. Times are ISO
// strings; the caller supplies "now". Frozen outputs; malformed inputs
// throw RecurrenceError. Actual room creation wiring is a later slice.
class RecurrenceError extends Error { constructor(code, message) { super(message); this.name = "RecurrenceError"; this.code = code; } }
const fail = (code, message) => { throw new RecurrenceError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_recurrence", message); };
const FREQUENCIES = ["daily", "weekly"];
// Create a recurrence manager. store is a caller-owned Map (scheduleId -> schedule).
export function createRecurrence({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const schedules = store ?? new Map();
  let scheduleCounter = 0;
  const getSchedule = scheduleId => {
    check(typeof scheduleId === "string" && scheduleId.length > 0, "scheduleId must be a non-empty string");
    check(schedules.has(scheduleId), `unknown schedule "${scheduleId}"`);
    return schedules.get(scheduleId);
  };
  // Create a recurring schedule.
  const create = ({ templateId, frequency, values, startAt }) => {
    check(typeof templateId === "string" && templateId.length > 0, "templateId must be a non-empty string");
    check(FREQUENCIES.includes(frequency), `frequency must be one of ${FREQUENCIES.join(", ")}`);
    check(values !== null && typeof values === "object", "values must be an object");
    check(typeof startAt === "string" && !Number.isNaN(Date.parse(startAt)), "startAt must be an ISO date string");
    const scheduleId = `rec-${++scheduleCounter}`;
    const schedule = { scheduleId, templateId, frequency,
      values: Object.freeze({ ...values }), startAt, created: Object.freeze([]) };
    schedules.set(scheduleId, schedule);
    return Object.freeze({ scheduleId, templateId, frequency, values: schedule.values, startAt });
  };
  // Compute the next occurrence after `now` (ISO string).
  const nextOccurrence = (scheduleId, { now }) => {
    const schedule = getSchedule(scheduleId);
    check(typeof now === "string" && !Number.isNaN(Date.parse(now)), "now must be an ISO date string");
    const start = Date.parse(schedule.startAt);
    const nowMs = Date.parse(now);
    const intervalMs = schedule.frequency === "daily" ? 86400000 : 604800000;
    let occurrence = start;
    while (occurrence <= nowMs) occurrence += intervalMs;
    return new Date(occurrence).toISOString();
  };
  // Record that an occurrence was created.
  const markCreated = (scheduleId, { occurrenceAt }) => {
    const schedule = getSchedule(scheduleId);
    check(typeof occurrenceAt === "string" && !Number.isNaN(Date.parse(occurrenceAt)),
      "occurrenceAt must be an ISO date string");
    check(!schedule.created.includes(occurrenceAt), `occurrence ${occurrenceAt} already created`);
    schedules.set(scheduleId, { ...schedule, created: Object.freeze([...schedule.created, occurrenceAt]) });
    return Object.freeze({ scheduleId, occurrenceAt });
  };
  // List created occurrences.
  const createdOccurrences = scheduleId => Object.freeze([...getSchedule(scheduleId).created]);
  return Object.freeze({ create, nextOccurrence, markCreated, createdOccurrences });
}
export { RecurrenceError, FREQUENCIES };
