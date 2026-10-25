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
// #3614 (accountability R-3): decision records — verdicts, receipts,
// settlements and their underlying events — carry their own retention
// class: a >=4-year default under legal hold (see RETENTION_POLICY in
// server/account-deletion.mjs, which declares the same floor for the
// records themselves). 1460 = 4 x 365, the day-count convention the
// severity table above already uses (730 = 2 years, 2555 = 7 years).
// A decision-bearing event can never classify below this floor, whatever
// its severity: before this class existed a routine verdict event at
// normal/low severity aged out at 180/30 days, far under the 4-year
// employment-decision regimes (CA FEHA ADS, IL IDHR draft) R-3 cites.
// The filed acceptance names the planner's "keep" action for a
// 3.9-year-old verdict event, so a decision-bearing event classifies
// keep (not archive) until the floor and purge only past it.
export const DECISION_RECORD_RETENTION_DAYS = 1460;
// Event types that bear a decision, anchored on the type strings this
// codebase actually emits: room verification/decision events
// (src/events.js) and bounty verdict/settlement events
// (server/bounty-escrow.mjs). Lifecycle noise (proposed, claimed,
// funded, snoozed) is deliberately absent — it is not a decision.
export const DECISION_EVENT_TYPES = Object.freeze([
  "verification.recorded",
  "decision.recorded",
  "owner.decision_recorded",
  "work.accepted",
  "work.completed",
  "receipt.evidence_withdrawn",
  "bounty.accepted",
  "bounty.approved",
  "bounty.decided",
  "bounty.declined",
  "bounty.disputed",
  "bounty.paid",
  "bounty.refunded",
  "bounty.rejected",
  "bounty.settled",
]);
const DECISION_EVENT_TYPE_SET = new Set(DECISION_EVENT_TYPES);
// An event is decision-bearing when its type is a decision type, or when
// the caller marks it explicitly (decisionBearing: true) — for decision
// events whose type vocabulary lives outside the two sets above, e.g. a
// caller's own verdict/settlement event stream.
export function isDecisionBearingEvent(value) {
  if (value === null || typeof value !== "object") return false;
  if (value.decisionBearing === true) return true;
  return typeof value.type === "string" && DECISION_EVENT_TYPE_SET.has(value.type);
}
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
  check(value.type === undefined || typeof value.type === "string", `event ${index} has a non-string type`);
  check(value.decisionBearing === undefined || typeof value.decisionBearing === "boolean", `event ${index} has a non-boolean decisionBearing`);
  return { id: value.id, at: value.at, severity, decisionBearing: isDecisionBearingEvent(value) };
};
// Decide retention for each event. now is injectable for tests.
export function retentionDecisions(events, { now, dryRun } = {}) {
  check(Array.isArray(events) && events.length <= 200000, "events must be a list of at most 200000");
  const at = now === undefined || now === null ? Date.now() : new Date(now).getTime();
  check(!Number.isNaN(at), "now must be a parseable timestamp");
  const decisions = [], totals = { keep: 0, archive: 0, purge: 0 };
  for (let index = 0; index < events.length; index++) {
    const { id, at: eventAt, severity, decisionBearing } = eventOf(events[index], index);
    const ageDays = Math.max(0, (at - new Date(eventAt).getTime()) / 86400000);
    // Decision-bearing events floor at the decision-record class: their
    // effective keep window is the longer of severity and the floor, and
    // they stay in the keep bucket until that window ends (see header).
    const keepDays = decisionBearing
      ? Math.max(SEVERITY_KEEP_DAYS[severity], DECISION_RECORD_RETENTION_DAYS)
      : SEVERITY_KEEP_DAYS[severity];
    const action = ageDays > keepDays ? "purge"
      : decisionBearing ? "keep"
      : ageDays > ARCHIVE_AFTER_DAYS ? "archive" : "keep";
    totals[action] += 1;
    decisions.push(Object.freeze({ id, severity, ageDays: Math.round(ageDays * 10) / 10,
      action, decisionBearing, keepDays, dryRun: dryRun === true }));
  }
  return Object.freeze({ dryRun: dryRun === true, totals: Object.freeze({ ...totals }),
    decisions: Object.freeze(decisions) });
}
export { RetentionError, SEVERITY_KEEP_DAYS, ARCHIVE_AFTER_DAYS };
