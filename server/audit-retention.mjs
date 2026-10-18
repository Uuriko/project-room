// Audit log retention (H004). A pure retention policy for audit events:
// each event is classified by age and severity into keep / archive / purge.
// Security-relevant events (auth, key, payment, admin) are kept longest;
// routine events age out first. dryRun mode reports what would happen
// without deciding anything destructive. The runner returns a decision per
// event plus totals; it performs no store writes — the caller executes the
// decisions. Pure, dependency-free, deterministic; frozen outputs. The
// scheduled caller is server/retention-run.mjs. It records the plan and
// does not delete.
const SEVERITY_KEEP_DAYS = Object.freeze({
  critical: 2555, // ~7 years: auth, keys, payments, admin actions
  high: 730,      // 2 years: approvals, membership changes
  normal: 180,    // 6 months: routine room/inbox events
  low: 30,        // 30 days: reads, searches, heartbeats
});
// #3614 (accountability R-3): decision-bearing events — the events
// underlying verdicts, receipts, and settlements — carry the explicit
// decision-records retention class declared in RETENTION_POLICY
// (server/account-deletion.mjs): at least four years, under legal hold.
// Four calendar years span 1461 days when a leap day intervenes, so the
// floor is 1461 and a decision event can never classify below four full
// years, whatever its severity class says. Decision events are kept in
// place (not archived, not purged) until their floored keep period
// passes: they are the live proof receipts and verdicts are read from.
const DECISION_RECORD_FLOOR_DAYS = 1461; // 4 years, counting a leap day
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
  return { id: value.id, at: value.at, severity, decision: value.decision === true };
};
// Decide retention for each event. now is injectable for tests.
export function retentionDecisions(events, { now, dryRun } = {}) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
  check(!Number.isNaN(at), "now must be a parseable timestamp");
  const decisions = [], totals = { keep: 0, archive: 0, purge: 0 };
  for (let index = 0; index < events.length; index++) {
    const { id, at: eventAt, severity, decision } = eventOf(events[index], index);
    const ageDays = Math.max(0, (at - new Date(eventAt).getTime()) / 86400000);
    // A decision-bearing event's keep period is its severity period
    // floored at the decision-records class: the class reconciles the
    // severity table so routine (normal/low) decision events cannot age
    // out at 180/30 days, far under the four-year floor.
    const keepDays = decision
      ? Math.max(SEVERITY_KEEP_DAYS[severity], DECISION_RECORD_FLOOR_DAYS)
      : SEVERITY_KEEP_DAYS[severity];
    const action = ageDays > keepDays ? "purge" : decision ? "keep" : ageDays > ARCHIVE_AFTER_DAYS ? "archive" : "keep";
    totals[action] += 1;
    decisions.push(Object.freeze({ id, severity, decision, keepDays, ageDays: Math.round(ageDays * 10) / 10,
      action, dryRun: dryRun === true }));
  }
  return Object.freeze({ dryRun: dryRun === true, totals: Object.freeze({ ...totals }),
    decisions: Object.freeze(decisions) });
}
export { RetentionError, SEVERITY_KEEP_DAYS, DECISION_RECORD_FLOOR_DAYS, ARCHIVE_AFTER_DAYS };
