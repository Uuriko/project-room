// H004: audit log retention. Pure policy tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { retentionDecisions, RetentionError, SEVERITY_KEEP_DAYS, DECISION_RECORD_RETENTION_DAYS, DECISION_EVENT_TYPES, isDecisionBearingEvent } from "../server/audit-retention.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RetentionError && error.code === code);
const NOW = "2026-09-16T12:00:00Z";
const events = () => [
  { id: "e1", at: "2026-09-16T10:00:00Z", severity: "normal" },   // fresh → keep
  { id: "e2", at: "2026-05-01T10:00:00Z", severity: "normal" },   // >90d, <180d → archive
  { id: "e3", at: "2025-01-01T10:00:00Z", severity: "normal" },   // >180d → purge
  { id: "e4", at: "2025-01-01T10:00:00Z", severity: "critical" }, // critical kept ~7y → archive
];

test("retentionDecisions classifies by age and severity", () => {
  const { decisions, totals } = retentionDecisions(events(), { now: NOW });
  assert.deepEqual(decisions.map(d => [d.id, d.action]),
    [["e1", "keep"], ["e2", "archive"], ["e3", "purge"], ["e4", "archive"]]);
  assert.deepEqual(totals, { keep: 1, archive: 2, purge: 1 });
  assert.ok(Object.isFrozen(decisions) && Object.isFrozen(totals));
  assert.equal(SEVERITY_KEEP_DAYS.critical, 2555);
});
test("dryRun flags the run without changing decisions", () => {
  const { dryRun, totals } = retentionDecisions(events(), { now: NOW, dryRun: true });
  assert.equal(dryRun, true);
  assert.equal(totals.purge, 1);
});
test("malformed inputs are refused", () => {
  throwsCode(() => retentionDecisions("nope"), "invalid_retention_input");
  throwsCode(() => retentionDecisions([{ id: "x", at: "bad" }]), "invalid_retention_input");
  throwsCode(() => retentionDecisions([{ id: "x", at: NOW, severity: "unknown" }]), "invalid_retention_input");
  throwsCode(() => retentionDecisions([{ id: "x", at: NOW, type: 7 }]), "invalid_retention_input");
  throwsCode(() => retentionDecisions([{ id: "x", at: NOW, decisionBearing: "yes" }]), "invalid_retention_input");
});

// #3614 (accountability R-3) filed acceptance: a 3.9-year-old verdict event
// classifies keep. Before the decision-record floor, the same event at
// normal severity purged at 180 days (and at 30 days for low).
const daysAgo = n => new Date(Date.parse(NOW) - n * 86400000).toISOString();
test("a 3.9-year-old verdict event classifies keep at every severity below the floor's own", () => {
  assert.equal(DECISION_RECORD_RETENTION_DAYS, 1460, "decision-record floor is 4 years (4 x 365)");
  for (const severity of ["low", "normal", "high"]) {
    const { decisions, totals } = retentionDecisions(
      [{ id: "verdict", at: daysAgo(1423), severity, type: "verification.recorded" }], { now: NOW });
    assert.equal(decisions[0].action, "keep", `${severity} verdict at 3.9y keeps`);
    assert.equal(decisions[0].decisionBearing, true);
    assert.equal(decisions[0].keepDays, 1460, "effective keep window is the decision floor, not the severity");
    assert.deepEqual(totals, { keep: 1, archive: 0, purge: 0 });
  }
});
test("decision-bearing events floor at 1460 days and purge only past it", () => {
  const settled = retentionDecisions(
    [{ id: "s1", at: daysAgo(1461), severity: "normal", type: "bounty.settled" }], { now: NOW });
  assert.equal(settled.decisions[0].action, "purge", "past the 4-year floor a decision event may age out");
  const marked = retentionDecisions(
    [{ id: "s2", at: daysAgo(1000), severity: "low", type: "caller.verdict", decisionBearing: true }], { now: NOW });
  assert.equal(marked.decisions[0].action, "keep", "the explicit marker floors a caller-typed decision event");
  assert.equal(marked.decisions[0].keepDays, 1460);
  const critical = retentionDecisions(
    [{ id: "s3", at: daysAgo(2000), severity: "critical", type: "bounty.decided" }], { now: NOW });
  assert.equal(critical.decisions[0].action, "keep", "a critical decision event keeps its longer severity window");
  assert.equal(critical.decisions[0].keepDays, 2555);
});
test("non-decision events keep the pre-#3614 severity classification exactly", () => {
  const { decisions } = retentionDecisions([
    { id: "n1", at: daysAgo(1423), severity: "normal" },                 // routine, old → purge (unchanged)
    { id: "n2", at: daysAgo(100), severity: "normal", type: "bounty.claimed" }, // lifecycle type, not a decision → archive
    { id: "n3", at: daysAgo(100), severity: "low", type: "verification.recorded" }, // decision → keep, never archive
  ], { now: NOW });
  assert.deepEqual(decisions.map(d => [d.id, d.action, d.decisionBearing]),
    [["n1", "purge", false], ["n2", "archive", false], ["n3", "keep", true]]);
});
test("isDecisionBearingEvent names the decision types and only those", () => {
  assert.ok(DECISION_EVENT_TYPES.includes("verification.recorded"));
  assert.ok(DECISION_EVENT_TYPES.includes("bounty.settled"));
  assert.equal(isDecisionBearingEvent({ type: "bounty.decided" }), true);
  assert.equal(isDecisionBearingEvent({ type: "bounty.claimed" }), false);
  assert.equal(isDecisionBearingEvent({ type: "message.posted" }), false);
  assert.equal(isDecisionBearingEvent({ decisionBearing: true }), true);
  assert.equal(isDecisionBearingEvent({}), false);
  assert.equal(isDecisionBearingEvent(null), false);
});
