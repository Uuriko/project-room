// Q010: performance regression gates (p95 budgets per route) tests.
//
// Pure unit tests over the module's own API: nearest-rank percentile math
// on known sample sets (odd/even counts, single sample, unsorted input),
// policy creation/validation, per-route evaluation including the exact
// p95 == budget boundary, the warning tier, multi-route aggregation, the
// empty-samples edge, and input validation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUDGETS,
  DEFAULT_POLICY,
  DEFAULT_WARN_MARGIN,
  TIER_FAIL,
  TIER_PASS,
  TIER_WARN,
  budgetFor,
  createPolicy,
  evaluateAll,
  evaluateRoute,
  isTier,
  latencySummary,
  percentile,
  setBudget
} from "../src/perf-gates.mjs";

const approx = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≈ ${expected}`);

test("percentile uses nearest-rank on odd sample counts", () => {
  const samples = [10, 20, 30, 40, 50];
  // p50: rank ceil(0.5 * 5) = 3 -> 30.
  assert.equal(percentile(samples, 50), 30);
  // p95: rank ceil(0.95 * 5) = 5 -> 50.
  assert.equal(percentile(samples, 95), 50);
  assert.equal(percentile(samples, 99), 50);
  assert.equal(percentile(samples, 100), 50);
  // p20: rank ceil(0.2 * 5) = 1 -> 10.
  assert.equal(percentile(samples, 20), 10);
});

test("percentile uses nearest-rank on even sample counts", () => {
  const samples = [10, 20, 30, 40];
  // p50: rank ceil(0.5 * 4) = 2 -> 20 (nearest-rank, not the 25 mean).
  assert.equal(percentile(samples, 50), 20);
  // p95: rank ceil(0.95 * 4) = 4 -> 40.
  assert.equal(percentile(samples, 95), 40);
});

test("percentile handles single samples, unsorted input, and empties", () => {
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([7], 99), 7);
  // Unsorted input is sorted internally.
  assert.equal(percentile([50, 10, 40, 20, 30], 50), 30);
  // Empty samples: no percentile to report.
  assert.equal(percentile([], 95), null);
});

test("percentile validates its inputs", () => {
  assert.throws(() => percentile("nope", 95), TypeError);
  assert.throws(() => percentile(null, 95), TypeError);
  assert.throws(() => percentile([10, -1], 95), TypeError);
  assert.throws(() => percentile([10, NaN], 95), TypeError);
  assert.throws(() => percentile([10, Infinity], 95), TypeError);
  assert.throws(() => percentile([10, "20"], 95), TypeError);
  for (const bad of [0, -5, 100.0001, 101, NaN, Infinity, "95", null, undefined]) {
    assert.throws(() => percentile([1, 2, 3], bad), TypeError, `p=${String(bad)}`);
  }
});

test("latencySummary reports count, min, max, and the three percentiles", () => {
  const s = latencySummary([50, 10, 40, 20, 30]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 10);
  assert.equal(s.max, 50);
  assert.equal(s.p50, 30);
  assert.equal(s.p95, 50);
  assert.equal(s.p99, 50);
  const empty = latencySummary([]);
  assert.deepEqual(empty, { count: 0, min: null, max: null, p50: null, p95: null, p99: null });
  assert.throws(() => latencySummary("nope"), TypeError);
});

test("createPolicy merges overrides over the defaults and validates", () => {
  const p = createPolicy();
  assert.deepEqual(p.budgets, DEFAULT_BUDGETS);
  assert.notEqual(p.budgets, DEFAULT_BUDGETS); // copied, not aliased
  assert.equal(p.warnMargin, DEFAULT_WARN_MARGIN);
  assert.equal(p.name, DEFAULT_POLICY.name);

  // Budgets merge: overrides replace per route, the rest stay.
  const custom = createPolicy({ budgets: { "/api/session": 500, "/brand-new": 10 } });
  assert.equal(custom.budgets["/api/session"], 500);
  assert.equal(custom.budgets["/brand-new"], 10);
  assert.equal(custom.budgets["/sends"], DEFAULT_BUDGETS["/sends"]);
  assert.equal(DEFAULT_POLICY.budgets["/api/session"], DEFAULT_BUDGETS["/api/session"]); // untouched

  const margin = createPolicy({ warnMargin: 0.5 });
  assert.equal(margin.warnMargin, 0.5);

  assert.throws(() => createPolicy(null), TypeError);
  assert.throws(() => createPolicy([]), TypeError);
  assert.throws(() => createPolicy({ budgets: { "/x": 0 } }), TypeError);
  assert.throws(() => createPolicy({ budgets: { "/x": -50 } }), TypeError);
  assert.throws(() => createPolicy({ budgets: { "/x": NaN } }), TypeError);
  assert.throws(() => createPolicy({ budgets: { "/x": Infinity } }), TypeError);
  assert.throws(() => createPolicy({ budgets: { "/x": "fast" } }), TypeError);
  assert.throws(() => createPolicy({ budgets: { "": 50 } }), TypeError);
  // An empty array spreads to no override entries: budgets stay defaulted.
  assert.deepEqual(createPolicy({ budgets: [] }).budgets, DEFAULT_BUDGETS);
  assert.throws(() => createPolicy({ warnMargin: -0.1 }), TypeError);
  assert.throws(() => createPolicy({ warnMargin: 1 }), TypeError);
  assert.throws(() => createPolicy({ warnMargin: NaN }), TypeError);
});

test("setBudget returns a new policy without mutating the input", () => {
  const p = createPolicy();
  const tighter = setBudget(p, "/api/session", 60);
  assert.equal(tighter.budgets["/api/session"], 60);
  assert.equal(p.budgets["/api/session"], DEFAULT_BUDGETS["/api/session"]); // original untouched
  // New routes can be added.
  const added = setBudget(p, "/some/route", 123);
  assert.equal(added.budgets["/some/route"], 123);

  assert.throws(() => setBudget(p, "/api/session", 0), TypeError);
  assert.throws(() => setBudget(p, "/api/session", -1), TypeError);
  assert.throws(() => setBudget(p, "/api/session", NaN), TypeError);
  assert.throws(() => setBudget(p, "", 50), TypeError);
  assert.throws(() => setBudget(p, 42, 50), TypeError);
  assert.throws(() => setBudget(null, "/api/session", 50), TypeError);
});

test("budgetFor resolves budgets and rejects unknown routes", () => {
  assert.equal(budgetFor(DEFAULT_POLICY, "/api/session"), DEFAULT_BUDGETS["/api/session"]);
  assert.throws(() => budgetFor(DEFAULT_POLICY, "/nope"), TypeError);
  assert.throws(() => budgetFor(DEFAULT_POLICY, ""), TypeError);
});

test("evaluateRoute passes p95 exactly at budget, fails 1ms over", () => {
  const route = "/api/session"; // budget 100ms
  const budget = DEFAULT_BUDGETS[route];
  // 20 identical samples: p95 = 100 = budget -> pass, on the boundary.
  const at = evaluateRoute(route, new Array(20).fill(budget));
  assert.equal(at.p95, budget);
  assert.equal(at.pass, true);
  assert.equal(at.overageMs, 0);
  assert.equal(at.headroomMs, 0);
  approx(at.utilization, 1, "at.utilization");
  // 1ms over budget -> fail.
  const over = evaluateRoute(route, new Array(20).fill(budget + 1));
  assert.equal(over.p95, budget + 1);
  assert.equal(over.pass, false);
  assert.equal(over.tier, TIER_FAIL);
  assert.equal(over.overageMs, 1);
  assert.equal(over.headroomMs, 0);
});

test("evaluateRoute trips the warn tier inside the warning margin", () => {
  const route = "/api/session"; // budget 100ms, warn margin 0.2 -> warn at >= 80ms
  const budget = DEFAULT_BUDGETS[route];
  // 90% of budget: degrading but still passing.
  const warn = evaluateRoute(route, new Array(20).fill(budget * 0.9));
  assert.equal(warn.tier, TIER_WARN);
  assert.equal(warn.pass, true);
  assert.equal(warn.overageMs, 0);
  assert.equal(warn.headroomMs, budget * 0.1);
  approx(warn.utilization, 0.9, "warn.utilization");
  // 70% of budget: comfortably passing.
  const clean = evaluateRoute(route, new Array(20).fill(budget * 0.7));
  assert.equal(clean.tier, TIER_PASS);
  assert.equal(clean.pass, true);
  assert.equal(clean.headroomMs, budget * 0.3);
  // Custom margin moves the warn boundary: margin 0.5 warns at >= 50%.
  const custom = createPolicy({ warnMargin: 0.5 });
  assert.equal(evaluateRoute(route, new Array(20).fill(budget * 0.6), custom).tier, TIER_WARN);
  assert.equal(evaluateRoute(route, new Array(20).fill(budget * 0.4), custom).tier, TIER_PASS);
});

test("evaluateRoute reports percentiles, budget, and route context", () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const r = evaluateRoute("/sends", samples); // budget 400ms
  assert.equal(r.route, "/sends");
  assert.equal(r.count, 10);
  // n=10: p50 rank 5 -> 50; p95 rank ceil(9.5)=10 -> 100; p99 -> 100.
  assert.equal(r.p50, 50);
  assert.equal(r.p95, 100);
  assert.equal(r.p99, 100);
  assert.equal(r.budget, DEFAULT_BUDGETS["/sends"]);
  assert.equal(r.pass, true);
  assert.equal(r.tier, TIER_PASS);
});

test("evaluateRoute passes empty samples with null percentiles", () => {
  const r = evaluateRoute("/api/session", []);
  assert.equal(r.count, 0);
  assert.equal(r.p50, null);
  assert.equal(r.p95, null);
  assert.equal(r.p99, null);
  assert.equal(r.pass, true);
  assert.equal(r.tier, TIER_PASS);
  assert.equal(r.overageMs, 0);
  assert.equal(r.utilization, 0);
  assert.equal(r.headroomMs, DEFAULT_BUDGETS["/api/session"]);
});

test("evaluateRoute validates route and samples", () => {
  assert.throws(() => evaluateRoute("/unknown-route", [1, 2, 3]), TypeError);
  assert.throws(() => evaluateRoute("", [1, 2, 3]), TypeError);
  assert.throws(() => evaluateRoute("/api/session", "nope"), TypeError);
  assert.throws(() => evaluateRoute("/api/session", [10, -2]), TypeError);
  assert.throws(() => evaluateRoute("/api/session", [10, NaN]), TypeError);
  assert.throws(() => evaluateRoute("/api/session", [1], { budgets: {}, warnMargin: 0.2 }), TypeError);
});

test("evaluateAll aggregates per-route results with a summary", () => {
  const sessionBudget = DEFAULT_BUDGETS["/api/session"]; // 100
  const sendsBudget = DEFAULT_BUDGETS["/sends"]; // 400
  const healthBudget = DEFAULT_BUDGETS["/growth/health"]; // 50
  const observations = {
    "/api/session": new Array(20).fill(sessionBudget + 5), // fail, utilization 1.05
    "/sends": new Array(20).fill(sendsBudget * 0.9), // warn, utilization 0.9
    "/growth/health": new Array(20).fill(healthBudget * 0.5) // pass, utilization 0.5
  };
  const { results, summary } = evaluateAll(observations);
  assert.equal(results["/api/session"].tier, TIER_FAIL);
  assert.equal(results["/sends"].tier, TIER_WARN);
  assert.equal(results["/growth/health"].tier, TIER_PASS);
  assert.equal(summary.routeCount, 3);
  assert.equal(summary.sampled, 3);
  assert.equal(summary.pass, false);
  assert.equal(summary.tier, TIER_FAIL);
  assert.deepEqual(summary.failing, ["/api/session"]);
  assert.deepEqual(summary.warned, ["/sends"]);
  assert.equal(summary.worstRoute, "/api/session");
  approx(summary.maxUtilization, 1.05, "summary.maxUtilization");
});

test("evaluateAll reports warn overall when nothing fails but a route warns", () => {
  const sendsBudget = DEFAULT_BUDGETS["/sends"];
  const { summary } = evaluateAll({
    "/sends": new Array(20).fill(sendsBudget * 0.9),
    "/growth/health": new Array(20).fill(10)
  });
  assert.equal(summary.pass, true);
  assert.equal(summary.tier, TIER_WARN);
  assert.deepEqual(summary.failing, []);
  assert.deepEqual(summary.warned, ["/sends"]);
  // Highest utilization wins the worst-route slot.
  assert.equal(summary.worstRoute, "/sends");
});

test("evaluateAll passes cleanly with empty observations", () => {
  const { results, summary } = evaluateAll({});
  assert.deepEqual(results, {});
  assert.equal(summary.routeCount, 0);
  assert.equal(summary.sampled, 0);
  assert.equal(summary.pass, true);
  assert.equal(summary.tier, TIER_PASS);
  assert.deepEqual(summary.failing, []);
  assert.deepEqual(summary.warned, []);
  assert.equal(summary.worstRoute, null);
  assert.equal(summary.maxUtilization, 0);
});

test("evaluateAll skips worst-route ranking for unsampled routes", () => {
  const { summary } = evaluateAll({ "/api/session": [] });
  assert.equal(summary.sampled, 0);
  assert.equal(summary.worstRoute, null);
  assert.equal(summary.pass, true);
});

test("evaluateAll validates the observations map", () => {
  assert.throws(() => evaluateAll(null), TypeError);
  assert.throws(() => evaluateAll([]), TypeError);
  assert.throws(() => evaluateAll("nope"), TypeError);
  assert.throws(() => evaluateAll({ "/api/session": "nope" }), TypeError);
  assert.throws(() => evaluateAll({ "/unknown-route": [1, 2] }), TypeError);
});

test("isTier recognizes the three tiers", () => {
  assert.equal(isTier(TIER_PASS), true);
  assert.equal(isTier(TIER_WARN), true);
  assert.equal(isTier(TIER_FAIL), true);
  assert.equal(isTier("meh"), false);
  assert.equal(isTier(null), false);
});
