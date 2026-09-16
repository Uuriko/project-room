// Audit log retention (H004). A pure retention policy for audit events:
// each event is classified by age and severity into keep / archive / purge.
// Security-relevant events (auth, key, payment, admin) are kept longest;
// routine events age out first. dryRun mode reports what would happen
// without deciding anything destructive. The runner returns a decision per
// event plus totals; it performs no store writes — the caller executes the
// decisions. Pure, dependency-free, deterministic; frozen outputs. Retention
// scheduler wiring is a later slice.
const SEVERITY_KEEP_DAYS = Object.freeze({
  critical: 2555, // ~7 years: auth, keys, payments, admin actions
  high: 730,      // 2 years: approvals, membership changes
  normal: 180,    // 6 months: routine room/inbox events
  low: 30,        // 30 days: reads, searches, heartbeats
});
const ARCHIVE_AFTER_DAYS = 90; // events older than this (but kept) move to archive
class RetentionError extends Error { constructor(code, message) { super(message); this.name = "RetentionError"; this.code = code; } }
const fail = (code, message) => { throw new RetentionError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_retention_input", message); };

const eventOf = (value, index) => {
  check(value !== null && typeof value === "object", `event ${index} must be an object`);
  check(typeof value.id === "string" && value.id.length > 0, `event ${index} needs an id`);
  check(typeof value.at === "string" && !Number.isNaN(new Date(value.at).getTime()), `event ${index} needs a parseable at timestamp`);
  const severity = value.severity ?? "normal";
  check(Object.hasOwn(SEVERITY_KEEP_DAYS, severity), `event ${index} has unknown severity "${severity}"`);
  return { id: value.id, at: value.at, severity };
};
// Decide retention for each event. now is injectable for tests.
export function retentionDecisions(events, { now, dryRun } = {}) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
  check(!Number.isNaN(at), "now must be a parseable timestamp");
  const decisions = [], totals = { keep: 0, archive: 0, purge: 0 };
  for (let index = 0; index < events.length; index++) {
    const { id, at: eventAt, severity } = eventOf(events[index], index);
    const ageDays = Math.max(0, (at - new Date(eventAt).getTime()) / 86400000);
    const keepDays = SEVERITY_KEEP_DAYS[severity];
    const action = ageDays > keepDays ? "purge" : ageDays > ARCHIVE_AFTER_DAYS ? "archive" : "keep";
    totals[action] += 1;
    decisions.push(Object.freeze({ id, severity, ageDays: Math.round(ageDays * 10) / 10,
      action, dryRun: dryRun === true }));
  }
  return Object.freeze({ dryRun: dryRun === true, totals: Object.freeze({ ...totals }),
    decisions: Object.freeze(decisions) });
}
export { RetentionError, SEVERITY_KEEP_DAYS, ARCHIVE_AFTER_DAYS };
