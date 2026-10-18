// Sampled production route counters (PERF2-MEASURE, PERF-2 programme §2).
//
// The deploy lane killed its telemetry item for one reason: no server-side
// latency surface existed. This is the minimal honest version — NOT
// per-request logging. The Durable Object's fetch funnel records one
// in-memory sample per served request (route class × status class ×
// coarse duration bucket: three Map increments, no I/O). Once per cron
// tick the accumulator folds into DO storage next to the job heartbeats,
// and GET /api/health/jobs reads the folded totals back. In-memory counts
// between folds are volatile by design and are reported separately as the
// instance delta, never silently merged — an instrument that hides its
// own capture gap is worse than none (CN-1).
//
// Buckets are the PERF-2 §1a budget edges (50 / 150 / 400 ms server time)
// plus resolution below and above them, so a bucket distribution can be
// read against the budgets directly.

export const ROUTE_STATS_STORAGE_KEY = "cron:route-stats:v1";

export const ROUTE_CLASSES = Object.freeze([
  "health", "operator", "mcp", "public", "commands", "room-api", "api-other", "page",
]);

export const DURATION_BUCKETS = Object.freeze([10, 50, 150, 400, 1000, Infinity]);
export const DURATION_LABELS = Object.freeze(["<=10ms", "<=50ms", "<=150ms", "<=400ms", "<=1000ms", ">1000ms"]);

export function routeClassFor(pathname) {
  const path = String(pathname ?? "");
  if (path.startsWith("/api/health")) return "health";
  if (path.startsWith("/api/operator/")) return "operator";
  if (path === "/mcp" || path.startsWith("/mcp/")) return "mcp";
  if (path.startsWith("/api/public/")) return "public";
  if (path.endsWith("/commands") || path.includes("/commands/")) return "commands";
  if (path.startsWith("/api/rooms/")) return "room-api";
  if (path.startsWith("/api/")) return "api-other";
  return "page";
}

export function statusClassFor(status) {
  const s = Number(status);
  if (s >= 200 && s < 300) return "2xx";
  if (s >= 300 && s < 400) return "3xx";
  if (s >= 400 && s < 500) return "4xx";
  if (s >= 500 && s < 600) return "5xx";
  return "other";
}

export function bucketIndexFor(durationMs) {
  const ms = Number(durationMs);
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (Number.isFinite(ms) && ms <= DURATION_BUCKETS[i]) return i;
  }
  return DURATION_BUCKETS.length - 1;
}

const emptyBuckets = () => DURATION_LABELS.map(() => 0);

export function createRouteStats() {
  return {
    total: 0,
    byClass: Object.fromEntries(ROUTE_CLASSES.map((c) => [c, 0])),
    byStatus: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 },
    buckets: emptyBuckets(),
  };
}

export function recordRouteSample(stats, { path, status, durationMs } = {}) {
  if (!stats) return;
  stats.total += 1;
  stats.byClass[routeClassFor(path)] += 1;
  stats.byStatus[statusClassFor(status)] += 1;
  stats.buckets[bucketIndexFor(durationMs)] += 1;
}

// Plain-object snapshot of an accumulator (safe to store / serialize).
export function snapshotRouteStats(stats) {
  if (!stats) return createRouteStats();
  return {
    total: stats.total,
    byClass: { ...stats.byClass },
    byStatus: { ...stats.byStatus },
    buckets: [...stats.buckets],
  };
}

// Fold one accumulator snapshot into the stored totals. Folding is pure
// addition, so it is lossless by construction: the folded total always
// equals the sum of every snapshot ever folded (asserted in tests).
export function foldRouteStats(stored, snapshot, now = Date.now()) {
  const base = stored && typeof stored === "object" ? snapshotRouteStats(stored) : createRouteStats();
  const add = snapshotRouteStats(snapshot);
  const merged = createRouteStats();
  merged.total = base.total + add.total;
  for (const c of ROUTE_CLASSES) merged.byClass[c] = (base.byClass[c] ?? 0) + (add.byClass[c] ?? 0);
  for (const s of Object.keys(merged.byStatus)) merged.byStatus[s] = (base.byStatus[s] ?? 0) + (add.byStatus[s] ?? 0);
  merged.buckets = base.buckets.map((v, i) => (v ?? 0) + (add.buckets[i] ?? 0));
  return {
    ...merged,
    windowStartedAt: stored?.windowStartedAt ?? now,
    persistedAt: now,
    folds: (Number(stored?.folds) || 0) + 1,
  };
}

// The health-surface view. `consistent` is the completeness check made
// visible: the class, status, and bucket distributions must each sum to
// the same total; a view that fails its own check says so on its face.
export function routeStatsView(stored, instanceDelta = null) {
  const totals = stored && typeof stored === "object" ? snapshotRouteStats(stored) : createRouteStats();
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + (Number(b) || 0), 0);
  const consistent = sum(totals.byClass) === totals.total
    && sum(totals.byStatus) === totals.total
    && totals.buckets.reduce((a, b) => a + b, 0) === totals.total;
  return {
    schema: "room.route-stats/1",
    consistent,
    total: totals.total,
    byClass: totals.byClass,
    byStatus: totals.byStatus,
    buckets: Object.fromEntries(DURATION_LABELS.map((label, i) => [label, totals.buckets[i] ?? 0])),
    windowStartedAt: stored?.windowStartedAt ? new Date(stored.windowStartedAt).toISOString() : null,
    persistedAt: stored?.persistedAt ? new Date(stored.persistedAt).toISOString() : null,
    folds: Number(stored?.folds) || 0,
    // Counts recorded by this DO instance since the last fold: real, but
    // not yet durable. Named, never merged into the totals above.
    instanceDeltaTotal: instanceDelta ? snapshotRouteStats(instanceDelta).total : 0,
  };
}
