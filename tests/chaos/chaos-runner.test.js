// Chaos harness self-checks.
//
// The scaffold's core promise is determinism: same seed + same code =>
// same outcome. These tests run the whole harness twice in-process with
// the same seed and require byte-identical report projections (wall-clock
// fields stripped), plus that every demo scenario passes and every
// recorded invariant check is ok.

import test from "node:test";
import assert from "node:assert/strict";
import { runAll, deterministicProjection, loadScenarios } from "./chaos-runner.mjs";

test("chaos harness: scenario registry loads the demo scenarios", async () => {
  const scenarios = await loadScenarios();
  const names = scenarios.map((s) => s.name).sort();
  assert.deepEqual(names, ["claim-release", "transfer-conservation"]);
});

test("chaos harness: demo scenarios pass under faults", async (t) => {
  const reports = await runAll({ seed: 42, reportPath: null });
  assert.equal(reports.length, 2);
  for (const report of reports) {
    assert.equal(report.outcome, "pass", `${report.scenario}: ${JSON.stringify(report.error)}`);
    assert.ok(report.faults.length > 0, `${report.scenario} injected no faults`);
    for (const check of report.checks) {
      assert.equal(check.ok, true, `${report.scenario} / ${check.name}: ${check.detail}`);
    }
  }
});

test("chaos harness: same seed twice => identical outcome (deterministic)", async () => {
  const run = () => runAll({ seed: 20261008, reportPath: null });
  const [first, second] = [await run(), await run()];
  assert.equal(first.length, second.length);
  for (let i = 0; i < first.length; i++) {
    assert.deepEqual(
      deterministicProjection(second[i]),
      deterministicProjection(first[i]),
      `scenario ${first[i].scenario} differs across identical seeds`,
    );
  }
});

test("chaos harness: kill fault fires at the same statement on repeat seeds", async () => {
  const killAt = (reports) =>
    reports
      .flatMap((r) => r.faults)
      .filter((f) => f.type === "kill_armed")
      .map((f) => f.at_statement);
  const [first, second] = [
    await runAll({ seed: 7, reportPath: null }),
    await runAll({ seed: 7, reportPath: null }),
  ];
  assert.deepEqual(killAt(second), killAt(first));
  assert.ok(killAt(first).length > 0, "expected at least one armed kill");
});

test("chaos harness: different seeds also pass (fault schedule is not seed-lucky)", async () => {
  for (const seed of [1, 99, 123456]) {
    const reports = await runAll({ seed, reportPath: null });
    for (const report of reports) {
      assert.equal(report.outcome, "pass", `seed ${seed} / ${report.scenario}: ${JSON.stringify(report.error)}`);
    }
  }
});
