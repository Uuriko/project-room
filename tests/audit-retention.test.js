// H004: audit log retention. Pure policy tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { retentionDecisions, RetentionError, SEVERITY_KEEP_DAYS } from "../server/audit-retention.mjs";

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
});
