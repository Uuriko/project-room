// Rate-limit tuning + dashboard support (F003). Pure, injectable logic that
// extends the rate-limit work without touching it: evaluates a per-key /
// per-route limit policy with burst allowance, produces tuning
// recommendations from observed traffic ("raise_limit", "lower_limit",
// "add_burst_headroom"), and assembles dashboard data (per-key usage
// summaries, top-limited keys, window utilization) as plain JSON-ready
// objects a UI can render.
// No framework, no I/O, no clock reads: every input is injected. Results are
// deep-frozen. Traffic stats describe one observation window per key.
class RateLimitDashboardError extends Error {
  constructor(code, message) { super(message); this.name = "RateLimitDashboardError"; this.code = code; }
}
const fail = (code, message) => { throw new RateLimitDashboardError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
const isPlainObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

// One route entry: { limit, windowMs, burst }.
// limit: sustained requests allowed per window (> 0). windowMs: window length
// in milliseconds (> 0). burst: extra headroom tokens for spikes (>= 0 int).
const checkEntry = (entry, where) => {
  check(isPlainObject(entry), "invalid_policy", `${where} must be an object`);
  check(typeof entry.limit === "number" && Number.isFinite(entry.limit) && entry.limit > 0,
    "invalid_policy", `${where}.limit must be a finite number > 0`);
  check(typeof entry.windowMs === "number" && Number.isFinite(entry.windowMs) && entry.windowMs > 0,
    "invalid_policy", `${where}.windowMs must be a finite number > 0`);
  check(Number.isInteger(entry.burst) && entry.burst >= 0,
    "invalid_policy", `${where}.burst must be an integer >= 0`);
  return Object.freeze({ limit: entry.limit, windowMs: entry.windowMs, burst: entry.burst });
};

// Validate a tuning policy: { default: entry, routes?: { name: entry } }.
// Returns a normalized, frozen policy. Traffic keys whose route is missing
// from `routes` (or that name no route at all) resolve to `default`.
export function validatePolicy(policy) {
  check(isPlainObject(policy), "invalid_policy", "policy must be an object");
  const normalized = { default: checkEntry(policy.default, "policy.default") };
  check(policy.routes === undefined || isPlainObject(policy.routes), "invalid_policy", "policy.routes must be an object");
  normalized.routes = Object.freeze(Object.fromEntries(
    Object.entries(policy.routes ?? {}).map(([name, entry]) => [name, checkEntry(entry, `policy.routes.${name}`)])
  ));
  return Object.freeze(normalized);
}

const checkKey = key => check(typeof key === "string" && key.length > 0 && key.length <= 256,
  "invalid_traffic", "traffic key names must be non-empty strings up to 256 chars");
const checkCount = (value, where) => check(Number.isInteger(value) && value >= 0,
  "invalid_traffic", `${where} must be an integer >= 0`);

// One traffic entry: { route?, requests, rejected, peak? }.
// requests: observed requests in the window. rejected: rejected by the
// limiter (<= requests). peak: observed peak in-window demand; defaults to
// requests when omitted.
const checkTrafficEntry = (entry, key) => {
  check(isPlainObject(entry), "invalid_traffic", `traffic.keys.${key} must be an object`);
  check(entry.route === undefined || typeof entry.route === "string",
    "invalid_traffic", `traffic.keys.${key}.route must be a string`);
  checkCount(entry.requests, `traffic.keys.${key}.requests`);
  checkCount(entry.rejected, `traffic.keys.${key}.rejected`);
  check(entry.rejected <= entry.requests, "invalid_traffic", `traffic.keys.${key}.rejected cannot exceed requests`);
  if (entry.peak !== undefined) checkCount(entry.peak, `traffic.keys.${key}.peak`);
  return Object.freeze({
    route: entry.route,
    requests: entry.requests,
    rejected: entry.rejected,
    peak: entry.peak ?? entry.requests,
  });
};

// Validate observed traffic: { keys?: { key: entry } }. Missing traffic is
// treated as "no observations yet" ({ keys: {} }). Returns frozen.
export function validateTraffic(traffic) {
  if (traffic === undefined || traffic === null) return Object.freeze({ keys: Object.freeze({}) });
  check(isPlainObject(traffic), "invalid_traffic", "traffic must be an object");
  check(traffic.keys === undefined || isPlainObject(traffic.keys), "invalid_traffic", "traffic.keys must be an object");
  const keys = Object.freeze(Object.fromEntries(
    Object.entries(traffic.keys ?? {}).map(([key, entry]) => { checkKey(key); return [key, checkTrafficEntry(entry, key)]; })
  ));
  return Object.freeze({ keys });
}

const freezeDeep = value => {
  if (Array.isArray(value)) { value.forEach(freezeDeep); return Object.freeze(value); }
  if (isPlainObject(value)) { Object.values(value).forEach(freezeDeep); return Object.freeze(value); }
  return value;
};

const resolveEntry = (policy, route) =>
  (typeof route === "string" && Object.hasOwn(policy.routes, route)) ? policy.routes[route] : policy.default;
const resolveRouteName = (policy, route) =>
  (typeof route === "string" && Object.hasOwn(policy.routes, route)) ? route : "default";

// Per-key tuning recommendation. Exactly one recommendation per key, by
// priority: raise_limit (rejections above highRejectRate) beats
// add_burst_headroom (rejections below the rate but peak blew past the
// limit+burst envelope) beats lower_limit (quiet keys far under their
// limit). Keys with no signal produce no recommendation.
export function recommendTuning(policy, traffic, options = {}) {
  const valid = validatePolicy(policy);
  const observed = validateTraffic(traffic);
  check(isPlainObject(options), "invalid_options", "options must be an object");
  const highRejectRate = options.highRejectRate ?? 0.05;
  const lowUtilization = options.lowUtilization ?? 0.1;
  const headroomFactor = options.headroomFactor ?? 1.25;
  check(typeof highRejectRate === "number" && highRejectRate > 0 && highRejectRate < 1,
    "invalid_options", "highRejectRate must be in (0, 1)");
  check(typeof lowUtilization === "number" && lowUtilization > 0 && lowUtilization < 1,
    "invalid_options", "lowUtilization must be in (0, 1)");
  check(typeof headroomFactor === "number" && headroomFactor > 1,
    "invalid_options", "headroomFactor must be > 1");

  const recommendations = [];
  for (const [key, entry] of Object.entries(observed.keys)) {
    const { limit, windowMs, burst } = resolveEntry(valid, entry.route);
    const route = resolveRouteName(valid, entry.route);
    const rejectionRate = entry.requests > 0 ? entry.rejected / entry.requests : 0;
    const utilization = entry.requests / limit;
    if (entry.requests > 0 && rejectionRate >= highRejectRate) {
      const suggested = Math.ceil(entry.requests * headroomFactor);
      recommendations.push({
        key, route, action: "raise_limit",
        reason: `rejection rate ${(rejectionRate * 100).toFixed(1)}% >= ${(highRejectRate * 100).toFixed(1)}% threshold`,
        current: { limit, windowMs, burst },
        suggested: { limit: Math.max(suggested, limit + 1), windowMs, burst },
        severity: rejectionRate >= 0.25 ? "high" : "medium",
      });
    } else if (entry.rejected > 0 && entry.peak > limit) {
      const shortfall = entry.peak - limit;
      recommendations.push({
        key, route, action: "add_burst_headroom",
        reason: `peak demand ${entry.peak} exceeded the ${limit}/window limit; burst of ${burst} did not cover the spike`,
        current: { limit, windowMs, burst },
        suggested: { limit, windowMs, burst: burst + Math.ceil(shortfall * 1.5) },
        severity: "medium",
      });
    } else if (entry.requests > 0 && entry.rejected === 0 && utilization < lowUtilization) {
      // Quiet key: keep 2x headroom over observed sustained demand, strictly
      // below the current limit (reachable here: requests >= 1 and
      // utilization < 1 implies limit >= 2, so limit - 1 >= 1).
      const suggested = Math.max(1, Math.min(Math.ceil(entry.requests * 2), limit - 1));
      recommendations.push({
        key, route, action: "lower_limit",
        reason: `utilization ${(utilization * 100).toFixed(1)}% < ${(lowUtilization * 100).toFixed(1)}% threshold with zero rejections`,
        current: { limit, windowMs, burst },
        suggested: { limit: suggested, windowMs, burst },
        severity: "low",
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return freezeDeep(recommendations);
}

// Per-key usage summary for the dashboard. Keys present in the policy but
// absent from traffic summarize as zero-traffic ("idle"). Unknown routes in
// traffic resolve to the policy default.
export function summarizeKeyUsage(policy, traffic) {
  const valid = validatePolicy(policy);
  const observed = validateTraffic(traffic);
  const summaries = [];
  const push = (key, routeName, entry, stats) => {
    const { limit, windowMs, burst } = entry;
    const { requests, rejected, peak } = stats;
    const admitted = requests - rejected;
    const rejectionRate = requests > 0 ? rejected / requests : 0;
    const utilization = requests / limit;
    const peakHeadroom = (limit + burst) - peak;
    const status = rejected > 0 ? "limited" : utilization >= 0.8 ? "hot" : utilization < 0.1 ? "idle" : "ok";
    summaries.push({ key, route: routeName, limit, windowMs, burst, requests, rejected, admitted, rejectionRate, utilization, peak, peakHeadroom, status });
  };
  for (const [key, stats] of Object.entries(observed.keys)) {
    push(key, resolveRouteName(valid, stats.route), resolveEntry(valid, stats.route), stats);
  }
  summaries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return freezeDeep(summaries);
}

// Keys with the most rejections, highest first (ties by key). Pure helper
// for the dashboard's "top limited" panel.
export function topLimitedKeys(policy, traffic, { topN = 10 } = {}) {
  check(Number.isInteger(topN) && topN >= 1, "invalid_options", "topN must be an integer >= 1");
  return freezeDeep(summarizeKeyUsage(policy, traffic)
    .filter(summary => summary.rejected > 0)
    .sort((a, b) => b.rejected - a.rejected || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, topN)
    .map(({ key, route, requests, rejected, rejectionRate }) => ({ key, route, requests, rejected, rejectionRate })));
}

// Window-level utilization stats: totals plus a per-route breakdown. Pure.
export function windowUtilization(policy, traffic) {
  const summaries = summarizeKeyUsage(policy, traffic);
  const routes = {};
  let requests = 0;
  let rejected = 0;
  let utilizationSum = 0;
  for (const summary of summaries) {
    requests += summary.requests;
    rejected += summary.rejected;
    utilizationSum += summary.utilization;
    const bucket = routes[summary.route] ?? { keys: 0, requests: 0, rejected: 0 };
    bucket.keys += 1;
    bucket.requests += summary.requests;
    bucket.rejected += summary.rejected;
    routes[summary.route] = bucket;
  }
  for (const bucket of Object.values(routes)) {
    bucket.rejectionRate = bucket.requests > 0 ? bucket.rejected / bucket.requests : 0;
  }
  return freezeDeep({
    keys: summaries.length,
    requests,
    rejected,
    rejectionRate: requests > 0 ? rejected / requests : 0,
    avgUtilization: summaries.length > 0 ? utilizationSum / summaries.length : 0,
    routes,
  });
}

// Full dashboard payload: per-key summaries, top-limited panel, window
// utilization, and tuning recommendations. One call for the UI to render.
export function assembleDashboard(policy, traffic, { topN = 10 } = {}) {
  const recommendations = recommendTuning(policy, traffic);
  return freezeDeep({
    keys: summarizeKeyUsage(policy, traffic),
    topLimited: topLimitedKeys(policy, traffic, { topN }),
    utilization: windowUtilization(policy, traffic),
    recommendations,
  });
}

export { RateLimitDashboardError };
