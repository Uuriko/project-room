// tests/event-survival-metrics.test.js — fail-first for WAVE-500 W16
// (dashboard + gauge integration for event survival).
//
// Pure calculation helpers in server/event-survival-metrics.mjs:
//   namespaceUsage(events, budgets)          — per-namespace budget math
//   compactionStats(before, after)           — sweep effectiveness
//   rotationWatermark(sequence, bytes, caps) — 75/85/95/100 watermark phases
//
// The helpers feed the WAVE-300 trip-wire gauges (spec in
// docs/wave500/TELEMETRY-EXTENSION.md) and the ops dashboard cards.
// This test file is RED until server/event-survival-metrics.mjs exists.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  namespaceUsage,
  compactionStats,
  rotationWatermark,
} from "../server/event-survival-metrics.mjs";

const BUDGETS = {
  enabled: true,
  namespaces: {
    default: { floor: 20000, burst: 20000, maxBorrow: 10000 },
    "guild-load": { floor: 20000, burst: 20000, maxBorrow: 10000 },
  },
};

test("namespaceUsage: computes ceiling, remaining, ratio, status per namespace", () => {
  const out = namespaceUsage(
    [
      { namespace: "default", events: 5000 },
      { namespace: "guild-load", events: 30000 },
    ],
    BUDGETS
  );
  assert.equal(out.enabled, true);
  assert.equal(out.namespaces.length, 2);
  const dflt = out.namespaces.find(n => n.namespace === "default");
  assert.equal(dflt.consumed, 5000);
  assert.equal(dflt.floor, 20000);
  assert.equal(dflt.ceiling, 50000); // floor + burst + maxBorrow
  assert.equal(dflt.remaining, 45000);
  assert.equal(dflt.borrowed, 0); // consumed below floor: nothing borrowed
  assert.ok(Math.abs(dflt.remainingRatio - 0.9) < 1e-12);
  assert.equal(dflt.status, "ok");

  const gl = out.namespaces.find(n => n.namespace === "guild-load");
  assert.equal(gl.consumed, 30000);
  assert.equal(gl.borrowed, 10000); // 30000 consumed - 20000 floor
  assert.equal(gl.remaining, 20000);
  assert.ok(Math.abs(gl.remainingRatio - 0.4) < 1e-12);
  assert.equal(gl.status, "ok");
});

test("namespaceUsage: status thresholds warn at 0.25, critical at 0.1 (strict)", () => {
  const out = namespaceUsage(
    [
      { namespace: "default", events: 38000 },      // ratio 0.24 -> warn
      { namespace: "guild-load", events: 46000 },  // ratio 0.08 -> critical
    ],
    BUDGETS
  );
  assert.equal(out.namespaces.find(n => n.namespace === "default").status, "warn");
  assert.equal(out.namespaces.find(n => n.namespace === "guild-load").status, "critical");

  // exactly AT a threshold has not tripped (matches tripwires.mjs convention)
  const edge = namespaceUsage([{ namespace: "default", events: 37500 }], BUDGETS);
  assert.equal(edge.namespaces[0].remainingRatio, 0.25);
  assert.equal(edge.namespaces[0].status, "ok");
});

test("namespaceUsage: over-ceiling consumption clamps to 0 remaining, critical", () => {
  const out = namespaceUsage([{ namespace: "default", events: 999999 }], BUDGETS);
  const n = out.namespaces[0];
  assert.equal(n.remaining, 0);
  assert.equal(n.remainingRatio, 0);
  assert.equal(n.status, "critical");
});

test("namespaceUsage: accepts a plain {namespace: count} map for events", () => {
  const out = namespaceUsage({ default: 1000 }, BUDGETS);
  assert.equal(out.namespaces.length, 1);
  assert.equal(out.namespaces[0].namespace, "default");
  assert.equal(out.namespaces[0].consumed, 1000);
});

test("namespaceUsage: namespaces without a config are listed as unmetered, never dropped", () => {
  const out = namespaceUsage([{ namespace: "rogue-board", events: 123 }], BUDGETS);
  assert.deepEqual(out.unmetered, ["rogue-board"]);
  assert.equal(out.namespaces.length, 0);
});

test("namespaceUsage: empty events -> empty namespaces; disabled -> enabled:false", () => {
  assert.deepEqual(namespaceUsage([], BUDGETS).namespaces, []);
  const off = namespaceUsage([{ namespace: "default", events: 1 }], { enabled: false });
  assert.equal(off.enabled, false);
});

test("namespaceUsage: non-finite and missing counts read as 0, not NaN", () => {
  const out = namespaceUsage(
    [
      { namespace: "default", events: Number.NaN },
      { namespace: "guild-load" },
    ],
    BUDGETS
  );
  assert.equal(out.namespaces.find(n => n.namespace === "default").consumed, 0);
  assert.equal(out.namespaces.find(n => n.namespace === "guild-load").consumed, 0);
});

test("compactionStats: saves and ratios from a successful sweep", () => {
  const s = compactionStats(
    { bytes: 100000, events: 1000 },
    { bytes: 70000, events: 640 }
  );
  assert.equal(s.bytesBefore, 100000);
  assert.equal(s.bytesAfter, 70000);
  assert.equal(s.bytesSaved, 30000);
  assert.ok(Math.abs(s.bytesSavedRatio - 0.3) < 1e-12);
  assert.equal(s.eventsBefore, 1000);
  assert.equal(s.eventsAfter, 640);
  assert.equal(s.eventsSaved, 360);
  assert.ok(Math.abs(s.eventsSavedRatio - 0.36) < 1e-12);
});

test("compactionStats: zero before -> all ratios 0, no NaN", () => {
  const s = compactionStats({ bytes: 0, events: 0 }, { bytes: 0, events: 0 });
  assert.equal(s.bytesSavedRatio, 0);
  assert.equal(s.eventsSavedRatio, 0);
});

test("compactionStats: growth (after > before) is not negative savings", () => {
  const s = compactionStats({ bytes: 50000, events: 100 }, { bytes: 60000, events: 120 });
  assert.equal(s.bytesSaved, 0);
  assert.equal(s.bytesSavedRatio, 0);
  assert.equal(s.eventsSaved, 0);
});

test("rotationWatermark: 75/85/95/100 phases per ROOM-ROTATION-DESIGN.md", () => {
  assert.equal(rotationWatermark(100, 1000).phase, "ok");
  assert.equal(rotationWatermark(750000, 1000).phase, "notice");      // 0.75
  assert.equal(rotationWatermark(850000, 1000).phase, "warn");        // 0.85
  assert.equal(rotationWatermark(950000, 1000).phase, "freeze-pending"); // 0.95
  assert.equal(rotationWatermark(1000000, 1000).phase, "exhausted");  // 1.0
});

test("rotationWatermark: projection bytes can bind before the event budget", () => {
  const cap = 4 * 1024 * 1024; // PILOT_LIMITS.projectionBytes
  const w = rotationWatermark(100000, cap * 0.9); // events 0.10, projection 0.90
  assert.ok(Math.abs(w.eventRatio - 0.1) < 1e-12);
  assert.ok(Math.abs(w.projectionRatio - 0.9) < 1e-12);
  assert.ok(Math.abs(w.watermarkRatio - 0.9) < 1e-12);
  assert.equal(w.binding, "projection");
  assert.equal(w.phase, "warn");
});

test("rotationWatermark: events bind by default", () => {
  const w = rotationWatermark(950000, 1000);
  assert.equal(w.binding, "events");
  assert.ok(Math.abs(w.watermarkRatio - 0.95) < 1e-12);
});

test("rotationWatermark: clamps negatives and over-cap, honors injected caps", () => {
  const w = rotationWatermark(-5, -10, { eventsPerRoom: 1000, projectionCapBytes: 1000 });
  assert.equal(w.eventRatio, 0);
  assert.equal(w.projectionRatio, 0);
  assert.equal(w.watermarkRatio, 0);
  assert.equal(w.phase, "ok");

  const over = rotationWatermark(5000, 5000, { eventsPerRoom: 1000, projectionCapBytes: 1000 });
  assert.ok(over.watermarkRatio >= 1);
  assert.equal(over.phase, "exhausted");
});

test("rotationWatermark: 4MB projection cap is the default", () => {
  const w = rotationWatermark(0, 4 * 1024 * 1024);
  assert.ok(Math.abs(w.projectionRatio - 1.0) < 1e-12);
  assert.equal(w.phase, "exhausted");
});
