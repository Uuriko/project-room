// Retention cohorts (G009). A pure cohort analysis over a supplied list of
// room events: agents are bucketed into weekly cohorts by their first join,
// and each cohort reports the share still active N weeks later (week 0 = the
// join week itself, always 100%). Retention is "any event in the week", not
// just joins. The caller supplies the events — no store reads. Pure,
// dependency-free, deterministic; frozen outputs. Cohort UI is a later slice.
class CohortError extends Error { constructor(code, message) { super(message); this.name = "CohortError"; this.code = code; } }
const fail = (code, message) => { throw new CohortError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_cohort_input", message); };

const WEEK_MS = 7 * 86400000;
const eventOf = (value, index) => {
  check(value !== null && typeof value === "object", `event ${index} must be an object`);
  check(typeof value.actorId === "string" && value.actorId.length > 0, `event ${index} needs an actorId`);
  check(typeof value.at === "string" && !Number.isNaN(new Date(value.at).getTime()), `event ${index} needs a parseable at timestamp`);
  return value;
};
const weekStart = time => {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); // Monday
  return date.toISOString().slice(0, 10);
};
// Build weekly retention cohorts. weeks caps how many retention weeks per cohort.
export function retentionCohorts(events, { weeks } = {}) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const weekCount = weeks ?? 8;
  check(Number.isInteger(weekCount) && weekCount >= 1 && weekCount <= 52, "weeks must be an integer 1..52");
  const firstSeen = new Map(), activeWeeks = new Map();
  events.forEach((event, index) => {
    const { actorId, at } = eventOf(event, index);
    const time = new Date(at).getTime(), week = weekStart(time);
    if (!firstSeen.has(actorId) || time < firstSeen.get(actorId)) firstSeen.set(actorId, time);
    if (!activeWeeks.has(actorId)) activeWeeks.set(actorId, new Set());
    activeWeeks.get(actorId).add(week);
  });
  const cohorts = new Map();
  for (const [actorId, joinedAt] of firstSeen) {
    const cohort = weekStart(joinedAt);
    if (!cohorts.has(cohort)) cohorts.set(cohort, { members: new Set(), retained: Array.from({ length: weekCount }, () => 0) });
    const entry = cohorts.get(cohort);
    entry.members.add(actorId);
    const cohortStart = new Date(cohort).getTime();
    for (let week = 0; week < weekCount; week++) {
      const label = weekStart(cohortStart + week * WEEK_MS);
      if (activeWeeks.get(actorId).has(label)) entry.retained[week] += 1;
    }
  }
  const result = [...cohorts.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([cohort, entry]) => {
    const size = entry.members.size;
    return Object.freeze({ cohort, size,
      retention: Object.freeze(entry.retained.map(count => size === 0 ? null : Math.round((count / size) * 1000) / 10)) });
  });
  return Object.freeze(result);
}
export { CohortError };
