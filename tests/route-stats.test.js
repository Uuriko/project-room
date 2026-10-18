// PERF2-MEASURE: sampled route counters (cloudflare/route-stats.mjs).
// The module's completeness property is the point: folding is lossless and
// the health view's three distributions must sum to the same total — the
// view carries `consistent` on its face so a broken instrument says so.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bucketIndexFor, createRouteStats, foldRouteStats, recordRouteSample,
  routeClassFor, routeStatsView, snapshotRouteStats, statusClassFor,
} from "../cloudflare/route-stats.mjs";

test("route classes: budget-relevant surfaces classify distinctly", () => {
  assert.equal(routeClassFor("/api/health/jobs"), "health");
  assert.equal(routeClassFor("/api/operator/export"), "operator");
  assert.equal(routeClassFor("/mcp"), "mcp");
  assert.equal(routeClassFor("/mcp/tools"), "mcp");
  assert.equal(routeClassFor("/api/public/front-door"), "public");
  assert.equal(routeClassFor("/api/rooms/room-1/commands"), "commands");
  assert.equal(routeClassFor("/api/rooms/room-1/orient"), "room-api");
  assert.equal(routeClassFor("/api/account/terms"), "api-other");
  assert.equal(routeClassFor("/about"), "page");
  assert.equal(routeClassFor("/"), "page");
});

test("status classes and duration buckets follow the §1a edges", () => {
  assert.equal(statusClassFor(200), "2xx");
  assert.equal(statusClassFor(304), "3xx");
  assert.equal(statusClassFor(404), "4xx");
  assert.equal(statusClassFor(503), "5xx");
  assert.equal(statusClassFor(0), "other");
  assert.equal(bucketIndexFor(3), 0); // <=10ms
  assert.equal(bucketIndexFor(50), 1); // <=50ms — the message-post p50 edge
  assert.equal(bucketIndexFor(149), 2); // <=150ms
  assert.equal(bucketIndexFor(400), 3); // <=400ms
  assert.equal(bucketIndexFor(999), 4);
  assert.equal(bucketIndexFor(5000), 5);
  assert.equal(bucketIndexFor(NaN), 5); // an unmeasurable duration lands in the worst bucket, never dropped
});

test("recording + folding is lossless: folded totals equal every sample ever recorded", () => {
  const samples = [
    { path: "/api/public/front-door", status: 200, durationMs: 12 },
    { path: "/api/public/front-door", status: 200, durationMs: 800 },
    { path: "/api/rooms/r/commands", status: 201, durationMs: 40 },
    { path: "/api/health/jobs", status: 503, durationMs: 5 },
    { path: "/about", status: 404, durationMs: 3 },
    { path: "/mcp", status: 200, durationMs: 120 },
  ];
  let stored = null;
  let expectedTotal = 0;
  // Fold in three batches; the accumulator resets between folds (as the
  // DO's cron-tick fold does after a successful put).
  for (const batch of [samples.slice(0, 2), samples.slice(2, 5), samples.slice(5)]) {
    const acc = createRouteStats();
    for (const s of batch) { recordRouteSample(acc, s); expectedTotal += 1; }
    stored = foldRouteStats(stored, snapshotRouteStats(acc), 1700000000000 + expectedTotal);
  }
  assert.equal(stored.total, expectedTotal);
  assert.equal(stored.folds, 3);
  const view = routeStatsView(stored, null);
  assert.equal(view.consistent, true);
  assert.equal(view.total, samples.length);
  assert.equal(view.byClass.public, 2);
  assert.equal(view.byClass.commands, 1);
  assert.equal(view.byStatus["5xx"], 1);
  assert.equal(view.buckets["<=10ms"], 2); // 5ms health, 3ms page
  assert.equal(view.buckets["<=50ms"], 2); // 12ms front door, 40ms commands
  assert.equal(view.instanceDeltaTotal, 0);
});

test("the view names the volatile instance delta instead of merging it", () => {
  const acc = createRouteStats();
  recordRouteSample(acc, { path: "/api/health", status: 200, durationMs: 2 });
  const view = routeStatsView(null, acc);
  assert.equal(view.total, 0); // nothing persisted yet
  assert.equal(view.instanceDeltaTotal, 1); // ...but the delta is on the face of the view
  assert.equal(view.consistent, true);
  assert.equal(view.persistedAt, null);
});

test("a tampered stored shape reports consistent:false, never a quiet wrong total", () => {
  const view = routeStatsView({ total: 9, byClass: { public: 1 }, byStatus: { "2xx": 1 }, buckets: [1, 0, 0, 0, 0, 0], folds: 1, persistedAt: 1, windowStartedAt: 1 }, null);
  assert.equal(view.consistent, false);
});
