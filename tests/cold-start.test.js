// F011: cold-start optimization tests.
//
// Pure unit tests over the module's own API with an injected stub clock:
// budget math and boundary behavior, per-phase breakdown, deferral
// eligibility and ranking, parallelization savings, what-if projections,
// and input validation.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUDGET_MS,
  OPTIMIZATION_DEFER,
  OPTIMIZATION_PARALLELIZE,
  criticalPathMs,
  evaluateStartup,
  measurePhase,
  projectedTotal,
  recommendations,
  timeStartup,
  totalEstimate
} from "../src/cold-start.mjs";

// A slow startup: 2.6s total, 600ms of it deferrable.
const SLOW = [
  { name: "module import", estimatedMs: 400 },
  { name: "env load", estimatedMs: 150 },
  { name: "db connect", estimatedMs: 900 },
  { name: "cache warm", estimatedMs: 600, deferrable: true },
  { name: "schema validate", estimatedMs: 550 }
];

// Deterministic stub clock: each now() call advances by a fixed step.
const stubClock = (step = 10) => {
  let t = 1_000_000;
  return { now: () => (t += step) - step };
};

test("evaluateStartup totals phases against the 2s budget", () => {
  const result = evaluateStartup(SLOW);
  assert.equal(result.totalMs, 2600);
  assert.equal(result.budgetMs, DEFAULT_BUDGET_MS);
  assert.equal(result.withinBudget, false);
  assert.equal(result.overageMs, 600);
  assert.equal(result.headroomMs, 0);
  assert.equal(result.criticalPathMs, 2000);
  assert.equal(result.deferrableMs, 600);
  assert.equal(result.phases.length, 5);
  assert.deepEqual(result.phases[0], {
    name: "module import",
    estimatedMs: 400,
    deferrable: false,
    onCriticalPath: true,
    fraction: 400 / 2600
  });
  assert.equal(result.phases[3].onCriticalPath, false);
  // Fractions partition the total.
  const fractionSum = result.phases.reduce((sum, p) => sum + p.fraction, 0);
  assert.ok(Math.abs(fractionSum - 1) < 1e-12);
});

test("evaluateStartup reports under-budget with headroom", () => {
  const fast = [
    { name: "module import", estimatedMs: 400 },
    { name: "env load", estimatedMs: 150 },
    { name: "db connect", estimatedMs: 900 }
  ];
  const result = evaluateStartup(fast);
  assert.equal(result.totalMs, 1450);
  assert.equal(result.withinBudget, true);
  assert.equal(result.overageMs, 0);
  assert.equal(result.headroomMs, 550);
});

test("evaluateStartup treats exactly-on-budget as within budget", () => {
  const exact = [
    { name: "module import", estimatedMs: 1100 },
    { name: "db connect", estimatedMs: 900 }
  ];
  const result = evaluateStartup(exact);
  assert.equal(result.totalMs, 2000);
  assert.equal(result.withinBudget, true);
  assert.equal(result.overageMs, 0);
  assert.equal(result.headroomMs, 0);
});

test("evaluateStartup honors a custom budget", () => {
  const result = evaluateStartup(SLOW, 3000);
  assert.equal(result.budgetMs, 3000);
  assert.equal(result.withinBudget, true);
  assert.equal(result.headroomMs, 400);
  assert.throws(() => evaluateStartup(SLOW, 0), TypeError);
  assert.throws(() => evaluateStartup(SLOW, -5), TypeError);
});

test("totalEstimate and criticalPathMs summarize phase lists", () => {
  assert.equal(totalEstimate(SLOW), 2600);
  assert.equal(totalEstimate([]), 0);
  assert.equal(criticalPathMs(SLOW), 2000);
  // Deferring everything deferrable leaves exactly the critical path.
  const allDeferrable = SLOW.map((p) => ({ ...p, deferrable: true }));
  assert.equal(criticalPathMs(allDeferrable), 0);
  assert.throws(() => totalEstimate("nope"), TypeError);
});

test("recommendations ranks deferrals by savings, highest first", () => {
  const phases = [
    { name: "module import", estimatedMs: 1200 },
    { name: "telemetry init", estimatedMs: 500, deferrable: true },
    { name: "feature flags", estimatedMs: 800, deferrable: true },
    { name: "env load", estimatedMs: 300 }
  ]; // total 2800, over by 800
  const recs = recommendations(phases);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].kind, OPTIMIZATION_DEFER);
  assert.deepEqual(recs[0].phases, ["feature flags"]);
  assert.equal(recs[0].estimatedSavingsMs, 800);
  assert.deepEqual(recs[1].phases, ["telemetry init"]);
  assert.equal(recs[1].estimatedSavingsMs, 500);
  // "module import" and "env load" are independent too: one parallelize
  // recommendation ranks last (1200 + 300 - 1200 = 300).
  assert.equal(recs[2].kind, OPTIMIZATION_PARALLELIZE);
  assert.equal(recs[2].estimatedSavingsMs, 300);
});

test("recommendations excludes deferrable phases that have dependents", () => {
  const phases = [
    { name: "config load", estimatedMs: 700, deferrable: true },
    { name: "db connect", estimatedMs: 900 },
    { name: "seed data", estimatedMs: 800, dependsOn: ["config load"] }
  ]; // total 2400, over by 400
  const recs = recommendations(phases);
  // "config load" is deferrable but "seed data" depends on it — deferring
  // it would strand the dependent on the critical path, so no defer rec.
  assert.ok(!recs.some((r) => r.phases.includes("config load")));
  // Independent phases are still parallelizable: db connect (900) and
  // seed data (800) are not independent — seed data has a dependency.
  // Only "db connect" is independent, and a single phase has no group.
  assert.deepEqual(recs, []);
});

test("recommendations parallelizes independent phases: savings = sum - longest", () => {
  const phases = [
    { name: "module import", estimatedMs: 1100 },
    { name: "env load", estimatedMs: 400 },
    { name: "tls setup", estimatedMs: 300 },
    { name: "config parse", estimatedMs: 200 }
  ]; // total 2000 -> exactly on budget... add more to go over
  const over = [...phases, { name: "db connect", estimatedMs: 500 }];
  const recs = recommendations(over);
  const par = recs.filter((r) => r.kind === OPTIMIZATION_PARALLELIZE);
  assert.equal(par.length, 1);
  // All five are independent: sum 2500, longest 1100, savings 1400.
  assert.equal(par[0].estimatedSavingsMs, 1400);
  assert.equal(par[0].phases.length, 5);
});

test("recommendations is empty when already within budget", () => {
  assert.deepEqual(recommendations([{ name: "boot", estimatedMs: 500 }]), []);
  assert.deepEqual(recommendations(SLOW, 3000), []);
});

test("projectedTotal applies recommendations and lands under budget", () => {
  const recs = recommendations(SLOW);
  assert.ok(recs.length > 0);
  // Apply everything: defer cache warm (600) + parallelize the four
  // independent non-deferrable phases (400+150+900+550=2000, longest 900,
  // savings 1100). Total 2600 - 600 - 1100 = 900.
  const full = projectedTotal(SLOW, recs);
  assert.equal(full.totalMs, 900);
  assert.equal(full.withinBudget, true);
  assert.equal(full.headroomMs, 1100);
  assert.equal(full.appliedCount, recs.length);

  // Apply only the defer: 2600 - 600 = 2000, exactly on budget.
  const deferOnly = projectedTotal(
    SLOW,
    recs.filter((r) => r.kind === OPTIMIZATION_DEFER)
  );
  assert.equal(deferOnly.totalMs, 2000);
  assert.equal(deferOnly.withinBudget, true);
  assert.equal(deferOnly.appliedCount, 1);

  // Apply nothing: unchanged and over budget.
  const none = projectedTotal(SLOW, []);
  assert.equal(none.totalMs, 2600);
  assert.equal(none.withinBudget, false);
  assert.equal(none.overageMs, 600);
  assert.equal(none.appliedCount, 0);
});

test("projectedTotal rejects unknown and duplicated recommendations", () => {
  const recs = recommendations(SLOW);
  assert.throws(
    () =>
      projectedTotal(SLOW, [
        { kind: OPTIMIZATION_DEFER, phases: ["nonexistent phase"] }
      ]),
    TypeError
  );
  assert.throws(() => projectedTotal(SLOW, [{ kind: "teleport", phases: [] }]), TypeError);
  assert.throws(() => projectedTotal(SLOW, [recs[0], recs[0]]), TypeError);
  assert.throws(() => projectedTotal(SLOW, "nope"), TypeError);
  // A recommendation for different phases is not transferable.
  assert.throws(
    () =>
      projectedTotal(
        [{ name: "boot", estimatedMs: 2500 }],
        recs
      ),
    TypeError
  );
});

test("measurePhase and timeStartup use the injected clock deterministically", () => {
  const measured = measurePhase("work", () => {}, stubClock(25));
  assert.deepEqual(measured, { name: "work", estimatedMs: 25 });

  const calls = [];
  const defs = [
    { name: "a", work: () => calls.push("a"), deferrable: true },
    { name: "b", work: () => calls.push("b"), dependsOn: ["a"] }
  ];
  const phases = timeStartup(defs, stubClock(10));
  assert.deepEqual(calls, ["a", "b"]); // ran in definition order
  assert.deepEqual(phases, [
    { name: "a", estimatedMs: 10, deferrable: true, dependsOn: [] },
    { name: "b", estimatedMs: 10, deferrable: false, dependsOn: ["a"] }
  ]);
  // Definitions were not mutated.
  assert.deepEqual(defs[0].dependsOn, undefined);

  // Zero-duration work is allowed; a backwards clock is not.
  const zero = measurePhase("instant", () => {}, { now: () => 42 });
  assert.equal(zero.estimatedMs, 0);
  let t = 100;
  assert.throws(
    () => measurePhase("broken", () => {}, { now: () => t-- }),
    TypeError
  );

  assert.throws(() => measurePhase("", () => {}, stubClock()), TypeError);
  assert.throws(() => measurePhase("x", "not a function", stubClock()), TypeError);
  assert.throws(() => measurePhase("x", () => {}, null), TypeError);
  assert.throws(() => timeStartup("nope", stubClock()), TypeError);
  assert.throws(() => timeStartup([{ name: "x" }], stubClock()), TypeError);
});

test("phase validation rejects malformed phase lists", () => {
  assert.throws(() => evaluateStartup("nope"), TypeError);
  assert.throws(() => evaluateStartup([null]), TypeError);
  assert.throws(() => evaluateStartup([{ estimatedMs: 100 }]), TypeError);
  assert.throws(() => evaluateStartup([{ name: "", estimatedMs: 100 }]), TypeError);
  assert.throws(() => evaluateStartup([{ name: "a", estimatedMs: 0 }]), TypeError);
  assert.throws(() => evaluateStartup([{ name: "a", estimatedMs: -5 }]), TypeError);
  assert.throws(() => evaluateStartup([{ name: "a", estimatedMs: NaN }]), TypeError);
  assert.throws(() => evaluateStartup([{ name: "a", estimatedMs: Infinity }]), TypeError);
  assert.throws(
    () =>
      evaluateStartup([
        { name: "a", estimatedMs: 100 },
        { name: "a", estimatedMs: 200 }
      ]),
    TypeError
  );
  assert.throws(
    () => evaluateStartup([{ name: "a", estimatedMs: 100, deferrable: "yes" }]),
    TypeError
  );
  assert.throws(
    () => evaluateStartup([{ name: "a", estimatedMs: 100, dependsOn: "b" }]),
    TypeError
  );
  assert.throws(
    () =>
      evaluateStartup([
        { name: "a", estimatedMs: 100, dependsOn: ["ghost"] }
      ]),
    TypeError
  );
  assert.throws(
    () =>
      evaluateStartup([{ name: "a", estimatedMs: 100, dependsOn: ["a"] }]),
    TypeError
  );
});
