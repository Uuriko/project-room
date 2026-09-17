// Q010: performance regression gates (p95 budgets per route).
//
// This module answers "did this route get slower than we allow, and how
// close is it to the limit". It computes nearest-rank latency percentiles
// (p50/p95/p99) over observed sample arrays, holds a per-route p95 budget
// policy (milliseconds), and evaluates each route against its budget:
// comfortably under budget is a pass, within the warning margin of the
// budget is a warn (degradation signal, still passing), over budget is a
// fail. A multi-route evaluation rolls the per-route results up into one
// summary with the worst route, the failing routes, and an overall pass.
// Pure functions, plain arguments, no I/O — sample arrays and the policy
// are injectable so the same evaluation can run in CI gates, dashboards,
// and tests without touching a real clock or network.
//
// Percentile method: nearest-rank. For n sorted samples the p-th
// percentile is the sample at rank ceil(p/100 * n) (1-based), i.e. the
// smallest value v such that at least p% of the samples are <= v. This
// makes boundary behavior exact and testable: a p95 of exactly the
// budget passes, 1ms over fails.
//
// API:
//   TIER_PASS / TIER_WARN / TIER_FAIL — the three evaluation tiers:
//     "pass" (p95 comfortably under budget), "warn" (p95 within the
//     warning margin of budget — degradation signal, still passing),
//     "fail" (p95 over budget — regression).
//   DEFAULT_BUDGETS — stock p95 budgets (ms) keyed by room route path.
//   DEFAULT_WARN_MARGIN — stock warning margin: p95 at or above 80% of
//     budget (margin 0.2) trips the warn tier.
//   DEFAULT_POLICY — the stock policy: DEFAULT_BUDGETS + warnMargin.
//   percentile(samples, p) — nearest-rank p-th percentile of the samples
//     (0 < p <= 100). Returns null for an empty sample array. Throws
//     TypeError on non-array samples, non-finite or negative samples,
//     or p outside (0, 100].
//   latencySummary(samples) — { count, min, max, p50, p95, p99 } over
//     the samples; min/max/p50/p95/p99 are null when count is 0.
//   createPolicy(overrides) — merge overrides over DEFAULT_POLICY and
//     validate: budget overrides replace or add route budgets (each must
//     be a positive finite number keyed by a non-empty string), warnMargin
//     must satisfy 0 <= warnMargin < 1. Throws TypeError on anything else.
//   setBudget(policy, route, budgetMs) — return a NEW policy with the
//     route's p95 budget set (added or replaced); the input policy is
//     not mutated. Throws TypeError on invalid policy, route, or budget.
//   budgetFor(policy, route) — the p95 budget for a route. Throws
//     TypeError for an unknown route or invalid policy.
//   evaluateRoute(route, samples, policy) — evaluate one route's samples
//     against its budget. Returns { route, count, p50, p95, p99, budget,
//     pass, tier, overageMs, headroomMs, utilization } where pass is
//     p95 <= budget (the boundary passes), overageMs is how far p95 is
//     over budget (0 when passing), headroomMs is the remaining room
//     under budget (clamped at 0), and utilization is p95 / budget.
//     Empty samples pass with null percentiles (no traffic, no
//     regression). Throws TypeError for unknown routes, non-array
//     samples, or invalid sample values. The policy defaults to
//     DEFAULT_POLICY.
//   evaluateAll(observations, policy) — evaluate a { route: samples[] }
//     map. Returns { results, summary } where results maps each route to
//     its evaluateRoute result and summary is { routeCount, sampled,
//     pass, tier, failing, warned, worstRoute, maxUtilization }: tier is
//     the worst tier across routes, failing/warned are the route names
//     in each tier, worstRoute is the sampled route with the highest
//     utilization (null when nothing was sampled). Throws TypeError on
//     a non-object observations map or invalid per-route samples.

export const TIER_PASS = "pass";
export const TIER_WARN = "warn";
export const TIER_FAIL = "fail";

const TIERS = new Set([TIER_PASS, TIER_WARN, TIER_FAIL]);

// Stock p95 latency budgets in milliseconds, keyed by room route path.
// Lightweight reads get tight budgets; fan-out and simulation endpoints
// that do real work get looser ones.
export const DEFAULT_BUDGETS = {
  "/growth/health": 50,
  "/api/session": 100,
  "/api/inbox": 250,
  "/api/account-rooms": 250,
  "/connections": 250,
  "/sends": 400,
  "/channel-sends": 400,
  "/simulation": 2000
};

// Warn when p95 is within 20% of the budget (utilization >= 0.8).
export const DEFAULT_WARN_MARGIN = 0.2;

export const DEFAULT_POLICY = {
  name: "default-perf-gates",
  version: 1,
  budgets: { ...DEFAULT_BUDGETS },
  warnMargin: DEFAULT_WARN_MARGIN
};

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function assertSamples(samples, where) {
  if (!Array.isArray(samples)) {
    throw new TypeError(`${where}: samples must be an array, got ${String(samples)}`);
  }
  for (const [index, value] of samples.entries()) {
    if (!isFiniteNumber(value) || value < 0) {
      throw new TypeError(
        `${where}: samples[${index}] must be a non-negative finite number (ms), got ${String(value)}`
      );
    }
  }
}

function assertRouteName(route, where) {
  if (typeof route !== "string" || route.length === 0) {
    throw new TypeError(`${where}: route must be a non-empty string, got ${String(route)}`);
  }
}

function assertBudgets(budgets, where) {
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    throw new TypeError(`${where}: budgets must be an object mapping route -> ms`);
  }
  for (const [route, budget] of Object.entries(budgets)) {
    assertRouteName(route, `${where}.budgets`);
    if (!isFiniteNumber(budget) || budget <= 0) {
      throw new TypeError(
        `${where}.budgets[${JSON.stringify(route)}] must be a positive finite number (ms), got ${String(budget)}`
      );
    }
  }
}

function assertWarnMargin(warnMargin, where) {
  if (!isFiniteNumber(warnMargin) || warnMargin < 0 || warnMargin >= 1) {
    throw new TypeError(
      `${where}: warnMargin must satisfy 0 <= warnMargin < 1, got ${String(warnMargin)}`
    );
  }
}

function assertPolicyShape(policy, where = "policy") {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError(`${where} must be an object`);
  }
  assertBudgets(policy.budgets, where);
  assertWarnMargin(policy.warnMargin, where);
}

export function percentile(samples, p) {
  assertSamples(samples, "percentile");
  if (!isFiniteNumber(p) || p <= 0 || p > 100) {
    throw new TypeError(`percentile: p must satisfy 0 < p <= 100, got ${String(p)}`);
  }
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length); // 1-based nearest rank
  return sorted[Math.max(1, rank) - 1];
}

export function latencySummary(samples) {
  assertSamples(samples, "latencySummary");
  if (samples.length === 0) {
    return { count: 0, min: null, max: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];
  return {
    count: samples.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: at(50),
    p95: at(95),
    p99: at(99)
  };
}

export function createPolicy(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("overrides must be an object");
  }
  const budgets =
    overrides.budgets === undefined
      ? { ...DEFAULT_POLICY.budgets }
      : { ...DEFAULT_POLICY.budgets, ...overrides.budgets };
  const merged = {
    ...DEFAULT_POLICY,
    ...overrides,
    budgets,
    warnMargin: overrides.warnMargin ?? DEFAULT_POLICY.warnMargin
  };
  assertPolicyShape(merged, "createPolicy");
  return merged;
}

export function setBudget(policy, route, budgetMs) {
  assertPolicyShape(policy, "setBudget");
  assertRouteName(route, "setBudget");
  if (!isFiniteNumber(budgetMs) || budgetMs <= 0) {
    throw new TypeError(
      `setBudget: budgetMs must be a positive finite number (ms), got ${String(budgetMs)}`
    );
  }
  return { ...policy, budgets: { ...policy.budgets, [route]: budgetMs } };
}

export function budgetFor(policy, route) {
  assertPolicyShape(policy, "budgetFor");
  assertRouteName(route, "budgetFor");
  const budget = policy.budgets[route];
  if (budget === undefined) {
    throw new TypeError(`budgetFor: no budget configured for route ${JSON.stringify(route)}`);
  }
  return budget;
}

export function evaluateRoute(route, samples, policy = DEFAULT_POLICY) {
  assertPolicyShape(policy, "evaluateRoute");
  const budget = budgetFor(policy, route);
  assertSamples(samples, `evaluateRoute(${JSON.stringify(route)})`);
  const { count, p50, p95, p99 } = latencySummary(samples);
  if (count === 0) {
    // No traffic observed: nothing regressed. Report the budget so the
    // gate stays informative even with an empty window.
    return {
      route,
      count,
      p50,
      p95,
      p99,
      budget,
      pass: true,
      tier: TIER_PASS,
      overageMs: 0,
      headroomMs: budget,
      utilization: 0
    };
  }
  const utilization = p95 / budget;
  const tier =
    p95 > budget
      ? TIER_FAIL
      : utilization >= 1 - policy.warnMargin
        ? TIER_WARN
        : TIER_PASS;
  const overageMs = Math.max(0, p95 - budget);
  return {
    route,
    count,
    p50,
    p95,
    p99,
    budget,
    pass: tier !== TIER_FAIL,
    tier,
    overageMs,
    headroomMs: Math.max(0, budget - p95),
    utilization
  };
}

const TIER_SEVERITY = { [TIER_PASS]: 0, [TIER_WARN]: 1, [TIER_FAIL]: 2 };

export function evaluateAll(observations, policy = DEFAULT_POLICY) {
  assertPolicyShape(policy, "evaluateAll");
  if (observations === null || typeof observations !== "object" || Array.isArray(observations)) {
    throw new TypeError("evaluateAll: observations must be an object mapping route -> samples[]");
  }
  const results = {};
  for (const [route, samples] of Object.entries(observations)) {
    results[route] = evaluateRoute(route, samples, policy);
  }
  const entries = Object.values(results);
  const failing = entries.filter((r) => r.tier === TIER_FAIL).map((r) => r.route);
  const warned = entries.filter((r) => r.tier === TIER_WARN).map((r) => r.route);
  const sampled = entries.filter((r) => r.count > 0);
  const worst = sampled.reduce(
    (best, r) => (best === null || r.utilization > best.utilization ? r : best),
    null
  );
  const tier = entries.reduce(
    (worstTier, r) =>
      TIER_SEVERITY[r.tier] > TIER_SEVERITY[worstTier] ? r.tier : worstTier,
    TIER_PASS
  );
  return {
    results,
    summary: {
      routeCount: entries.length,
      sampled: sampled.length,
      pass: tier !== TIER_FAIL,
      tier,
      failing,
      warned,
      worstRoute: worst ? worst.route : null,
      maxUtilization: worst ? worst.utilization : 0
    }
  };
}

// Re-export the tier set shape check for consumers that branch on tiers.
export function isTier(value) {
  return TIERS.has(value);
}
