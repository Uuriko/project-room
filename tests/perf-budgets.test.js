// PERF2-MEASURE: the deterministic budget suite's CI-shadow form.
// Runs the small shapes of scripts/perf-budgets.mjs inside the suite and
// asserts the instrument's COMPLETENESS and PARITY checks (CN-1: an
// instrument that silently under-captures is worse than none) plus every
// budget row flagged enforced. Tracked budgets are reported, not asserted:
// their fixes land in named PRs (see scripts/perf-budgets.mjs header),
// and the landing PR flips the row's enforce flag in the same diff.
// Wall-clock is never asserted (shared runners are not a signal, §5.2).
import test from "node:test";
import assert from "node:assert/strict";
import { runPerfBudgets, BUDGETS } from "../scripts/perf-budgets.mjs";

test("perf-budgets small shape: completeness and parity hold, enforced budgets within", { timeout: 180000 }, () => {
  const report = runPerfBudgets({ small: true });
  const failed = report.completeness.filter((c) => !c.ok);
  assert.deepEqual(failed, [], `completeness failures: ${failed.map((f) => `${f.check} — ${f.detail}`).join("; ")}`);
  assert.equal(report.completenessOk, true);
  // Every shape family produced readings (a silently skipped shape is an
  // under-capture of exactly the kind CN-1 names).
  for (const shape of ["S1", "S2", "S3", "S4", "S5", "CMD"]) {
    assert.ok(report.readings.some((r) => r.shape === shape), `no readings for shape ${shape}`);
  }
  for (const row of BUDGETS.filter((b) => b.enforce)) {
    const evaluated = report.budgets.find((b) => b.id === row.id);
    assert.notEqual(evaluated?.status, "BREACH", `enforced budget ${row.id} breached`);
  }
});

test("perf-budgets budget table: every row names its fix vehicle", () => {
  for (const row of BUDGETS) {
    assert.ok(row.fix && row.fix.length > 3, `${row.id} must name the PR/charter that lands its fix`);
    assert.ok(Number.isFinite(row.budget) || row.budget === 0, `${row.id} budget must be numeric`);
  }
});
