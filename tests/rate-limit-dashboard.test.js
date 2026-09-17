// F003 — tests for src/rate-limit-dashboard.mjs.
//
// Covers policy/traffic validation, tuning recommendations at their
// boundaries (raise_limit / lower_limit / add_burst_headroom), per-key usage
// summaries, top-limited keys, window utilization, the assembled dashboard,
// and edge cases (empty traffic, unknown keys/routes, frozen results).

import test from "node:test";
import assert from "node:assert/strict";
import {
  RateLimitDashboardError,
  validatePolicy,
  validateTraffic,
  recommendTuning,
  summarizeKeyUsage,
  topLimitedKeys,
  windowUtilization,
  assembleDashboard,
} from "../src/rate-limit-dashboard.mjs";

const POLICY = {
  default: { limit: 60, windowMs: 60_000, burst: 10 },
  routes: {
    login: { limit: 10, windowMs: 60_000, burst: 5 },
    search: { limit: 100, windowMs: 60_000, burst: 20 },
  },
};

const assertDashboardError = (fn, code) => {
  assert.throws(fn, error => {
    assert.ok(error instanceof RateLimitDashboardError);
    assert.equal(error.code, code);
    return true;
  });
};

// --- policy validation ----------------------------------------------------

test("validatePolicy normalizes and freezes a valid policy", () => {
  const policy = validatePolicy(POLICY);
  assert.equal(policy.default.limit, 60);
  assert.equal(policy.routes.login.burst, 5);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.routes));
  assert.ok(Object.isFrozen(policy.routes.search));
});

test("validatePolicy accepts a policy with no routes", () => {
  const policy = validatePolicy({ default: { limit: 5, windowMs: 1000, burst: 0 } });
  assert.deepEqual(policy.routes, {});
});

test("validatePolicy rejects bad policies", () => {
  assertDashboardError(() => validatePolicy(null), "invalid_policy");
  assertDashboardError(() => validatePolicy({}), "invalid_policy");
  assertDashboardError(() => validatePolicy({ default: { limit: 0, windowMs: 1000, burst: 1 } }), "invalid_policy");
  assertDashboardError(() => validatePolicy({ default: { limit: 10, windowMs: -5, burst: 1 } }), "invalid_policy");
  assertDashboardError(() => validatePolicy({ default: { limit: 10, windowMs: 1000, burst: -1 } }), "invalid_policy");
  assertDashboardError(() => validatePolicy({ default: { limit: 10, windowMs: 1000, burst: 1.5 } }), "invalid_policy");
  assertDashboardError(
    () => validatePolicy({ default: POLICY.default, routes: { bad: { limit: 1, windowMs: 1 } } }),
    "invalid_policy"
  );
});

// --- traffic validation ---------------------------------------------------

test("validateTraffic treats missing traffic as no observations", () => {
  assert.deepEqual(validateTraffic(undefined), { keys: {} });
  assert.deepEqual(validateTraffic(null), { keys: {} });
  assert.deepEqual(validateTraffic({}), { keys: {} });
});

test("validateTraffic defaults peak to requests", () => {
  const traffic = validateTraffic({ keys: { alice: { route: "login", requests: 8, rejected: 0 } } });
  assert.equal(traffic.keys.alice.peak, 8);
});

test("validateTraffic rejects bad traffic", () => {
  assertDashboardError(() => validateTraffic({ keys: { "": { requests: 1, rejected: 0 } } }), "invalid_traffic");
  assertDashboardError(() => validateTraffic({ keys: { a: { requests: -1, rejected: 0 } } }), "invalid_traffic");
  assertDashboardError(() => validateTraffic({ keys: { a: { requests: 1.5, rejected: 0 } } }), "invalid_traffic");
  assertDashboardError(() => validateTraffic({ keys: { a: { requests: 3, rejected: 4 } } }), "invalid_traffic");
  assertDashboardError(() => validateTraffic({ keys: null }), "invalid_traffic");
});

// --- tuning recommendations -----------------------------------------------

const traffic = keys => ({ keys });

test("raise_limit fires at the rejection-rate boundary", () => {
  // Exactly 5% rejections hits the default 0.05 threshold.
  const recs = recommendTuning(POLICY, traffic({ alice: { route: "login", requests: 100, rejected: 5, peak: 12 } }));
  assert.equal(recs.length, 1);
  const [rec] = recs;
  assert.equal(rec.action, "raise_limit");
  assert.equal(rec.key, "alice");
  assert.equal(rec.route, "login");
  assert.equal(rec.severity, "medium");
  assert.equal(rec.suggested.limit, 125); // ceil(100 * 1.25)
  assert.ok(rec.suggested.limit > rec.current.limit);
  assert.ok(Object.isFrozen(rec));
  assert.ok(Object.isFrozen(recs));
});

test("raise_limit is high severity at >= 25% rejections", () => {
  const recs = recommendTuning(POLICY, traffic({ bob: { route: "search", requests: 100, rejected: 25, peak: 90 } }));
  assert.equal(recs[0].severity, "high");
  assert.equal(recs[0].suggested.limit, 125);
});

test("no raise_limit just below the rejection-rate threshold", () => {
  // 4/100 = 4% < 5%, peak inside the envelope, utilization 1.0 -> no signal.
  const recs = recommendTuning(
    POLICY,
    traffic({ carol: { route: "search", requests: 100, rejected: 4, peak: 100 } }),
    { highRejectRate: 0.05 }
  );
  assert.deepEqual(recs, []);
});

test("raise_limit beats add_burst_headroom when both could apply", () => {
  const recs = recommendTuning(POLICY, traffic({ dave: { route: "login", requests: 100, rejected: 40, peak: 60 } }));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].action, "raise_limit");
});

test("add_burst_headroom fires when a spike blows past the limit", () => {
  const recs = recommendTuning(POLICY, traffic({ erin: { route: "login", requests: 100, rejected: 1, peak: 16 } }));
  assert.equal(recs.length, 1);
  const [rec] = recs;
  assert.equal(rec.action, "add_burst_headroom");
  assert.equal(rec.severity, "medium");
  // shortfall 16 - 10 = 6 -> 5 + ceil(6 * 1.5) = 14
  assert.equal(rec.suggested.burst, 14);
  assert.equal(rec.suggested.limit, 10);
});

test("add_burst_headroom needs peak strictly above the limit", () => {
  const recs = recommendTuning(POLICY, traffic({ frank: { route: "login", requests: 100, rejected: 1, peak: 10 } }));
  assert.deepEqual(recs, []);
});

test("lower_limit fires for quiet keys below the utilization threshold", () => {
  const recs = recommendTuning(POLICY, traffic({ grace: { route: "search", requests: 5, rejected: 0, peak: 7 } }));
  assert.equal(recs.length, 1);
  const [rec] = recs;
  assert.equal(rec.action, "lower_limit");
  assert.equal(rec.severity, "low");
  assert.equal(rec.suggested.limit, 10); // ceil(5 * 2), strictly below 100
  assert.ok(rec.suggested.limit < rec.current.limit);
});

test("lower_limit does not fire at exactly the utilization threshold", () => {
  // utilization 10/100 = 0.1 is not < 0.1.
  const recs = recommendTuning(POLICY, traffic({ heidi: { route: "search", requests: 10, rejected: 0, peak: 10 } }));
  assert.deepEqual(recs, []);
});

test("lower_limit never fires for keys with zero requests", () => {
  const recs = recommendTuning(POLICY, traffic({ ivan: { route: "search", requests: 0, rejected: 0, peak: 0 } }));
  assert.deepEqual(recs, []);
});

test("empty traffic yields no recommendations", () => {
  assert.deepEqual(recommendTuning(POLICY, undefined), []);
  assert.deepEqual(recommendTuning(POLICY, { keys: {} }), []);
});

test("unknown routes in traffic resolve to the policy default", () => {
  const recs = recommendTuning(POLICY, traffic({ judy: { route: "nope", requests: 100, rejected: 30, peak: 70 } }));
  assert.equal(recs[0].route, "default");
  assert.equal(recs[0].current.limit, 60);
});

test("recommendations sort by severity then key", () => {
  const recs = recommendTuning(POLICY, traffic({
    zed: { route: "search", requests: 100, rejected: 6, peak: 90 }, // medium raise
    amy: { route: "search", requests: 100, rejected: 30, peak: 90 }, // high raise
    max: { route: "search", requests: 5, rejected: 0, peak: 5 }, // low lower
  }));
  assert.deepEqual(recs.map(r => r.key), ["amy", "zed", "max"]);
});

test("tuning thresholds are injectable via options", () => {
  const stats = traffic({ kim: { route: "search", requests: 100, rejected: 8, peak: 90 } });
  assert.equal(recommendTuning(POLICY, stats)[0].action, "raise_limit"); // 8% >= 5%
  assert.deepEqual(recommendTuning(POLICY, stats, { highRejectRate: 0.1 }), []); // 8% < 10%
  assertDashboardError(() => recommendTuning(POLICY, stats, { highRejectRate: 1.5 }), "invalid_options");
  assertDashboardError(() => recommendTuning(POLICY, stats, { lowUtilization: 0 }), "invalid_options");
  assertDashboardError(() => recommendTuning(POLICY, stats, { headroomFactor: 1 }), "invalid_options");
});

// --- per-key usage summaries ----------------------------------------------

test("summarizeKeyUsage builds JSON-ready per-key rows", () => {
  const rows = summarizeKeyUsage(POLICY, traffic({
    alice: { route: "login", requests: 12, rejected: 4, peak: 14 },
    bob: { route: "search", requests: 90, rejected: 0, peak: 95 },
  }));
  assert.equal(rows.length, 2);
  const alice = rows.find(r => r.key === "alice");
  assert.equal(alice.admitted, 8);
  assert.equal(alice.rejectionRate, 4 / 12);
  assert.equal(alice.utilization, 12 / 10);
  assert.equal(alice.peakHeadroom, (10 + 5) - 14);
  assert.equal(alice.status, "limited");
  const bob = rows.find(r => r.key === "bob");
  assert.equal(bob.status, "hot"); // 90/100 = 0.9 >= 0.8
  assert.ok(Object.isFrozen(rows));
  assert.ok(Object.isFrozen(alice));
  // JSON-ready: round-trips through JSON unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows);
});

test("summarizeKeyUsage status transitions", () => {
  const rows = summarizeKeyUsage(POLICY, traffic({
    hot: { route: "search", requests: 80, rejected: 0 }, // 0.8 -> hot
    ok: { route: "search", requests: 50, rejected: 0 }, // 0.5 -> ok
    idle: { route: "search", requests: 5, rejected: 0 }, // 0.05 -> idle
    zero: { route: "search", requests: 0, rejected: 0 }, // 0 -> idle
  }));
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.status]));
  assert.deepEqual(byKey, { hot: "hot", idle: "idle", ok: "ok", zero: "idle" });
});

test("summarizeKeyUsage sorts rows by key and handles empty traffic", () => {
  const rows = summarizeKeyUsage(POLICY, traffic({
    zed: { route: "login", requests: 1, rejected: 0 },
    amy: { route: "login", requests: 1, rejected: 0 },
  }));
  assert.deepEqual(rows.map(r => r.key), ["amy", "zed"]);
  assert.deepEqual(summarizeKeyUsage(POLICY, undefined), []);
});

// --- top limited keys ------------------------------------------------------

test("topLimitedKeys orders by rejections and respects topN", () => {
  const top = topLimitedKeys(POLICY, traffic({
    a: { route: "login", requests: 50, rejected: 5 },
    b: { route: "login", requests: 50, rejected: 20 },
    c: { route: "login", requests: 50, rejected: 20 },
    d: { route: "login", requests: 50, rejected: 0 },
  }), { topN: 2 });
  assert.deepEqual(top.map(t => t.key), ["b", "c"]); // tie -> key order
  assert.equal(top[0].rejectionRate, 20 / 50);
  const all = topLimitedKeys(POLICY, traffic({
    a: { route: "login", requests: 50, rejected: 5 },
    d: { route: "login", requests: 50, rejected: 0 },
  }));
  assert.ok(all.every(t => t.rejected > 0));
  assertDashboardError(() => topLimitedKeys(POLICY, traffic({}), { topN: 0 }), "invalid_options");
});

// --- window utilization ----------------------------------------------------

test("windowUtilization aggregates totals and per-route breakdown", () => {
  const util = windowUtilization(POLICY, traffic({
    a: { route: "login", requests: 20, rejected: 4 },
    b: { route: "login", requests: 10, rejected: 0 },
    c: { route: "search", requests: 200, rejected: 10 },
  }));
  assert.equal(util.keys, 3);
  assert.equal(util.requests, 230);
  assert.equal(util.rejected, 14);
  assert.equal(util.rejectionRate, 14 / 230);
  assert.equal(util.avgUtilization, (20 / 10 + 10 / 10 + 200 / 100) / 3);
  assert.equal(util.routes.login.keys, 2);
  assert.equal(util.routes.login.requests, 30);
  assert.equal(util.routes.login.rejected, 4);
  assert.equal(util.routes.login.rejectionRate, 4 / 30);
  assert.equal(util.routes.search.keys, 1);
  assert.ok(Object.isFrozen(util));
});

test("windowUtilization on empty traffic is all zeros", () => {
  assert.deepEqual(windowUtilization(POLICY, undefined), {
    keys: 0, requests: 0, rejected: 0, rejectionRate: 0, avgUtilization: 0, routes: {},
  });
});

// --- assembled dashboard ---------------------------------------------------

test("assembleDashboard returns the full UI payload", () => {
  const dashboard = assembleDashboard(POLICY, traffic({
    alice: { route: "login", requests: 100, rejected: 10, peak: 14 },
    bob: { route: "search", requests: 5, rejected: 0, peak: 5 },
  }), { topN: 5 });
  assert.equal(dashboard.keys.length, 2);
  assert.equal(dashboard.topLimited.length, 1);
  assert.equal(dashboard.topLimited[0].key, "alice");
  assert.equal(dashboard.utilization.keys, 2);
  assert.equal(dashboard.recommendations.length, 2); // raise for alice, lower for bob
  assert.ok(Object.isFrozen(dashboard));
  assert.deepEqual(JSON.parse(JSON.stringify(dashboard)), dashboard);
});

test("dashboard results cannot be mutated", () => {
  const dashboard = assembleDashboard(POLICY, traffic({ alice: { route: "login", requests: 10, rejected: 1 } }));
  assert.throws(() => { dashboard.keys.push({}); }, TypeError);
  assert.throws(() => { dashboard.utilization.requests = 999; }, TypeError);
});
