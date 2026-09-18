// Task 26 — SLA dashboard unit tests (fixtures only: no live Telegram, no
// live email, no network). Exercises the pure aggregation module
// (server/sla-dashboard.mjs): percentile math, breach aggregation by channel
// and severity, and the unowned end-of-day sweep filter.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSlaDashboard, responseTimePercentiles, severityFor,
  slaSeverities, criticalAtRatio, SlaDashboardError } from "../server/sla-dashboard.mjs";
import { slaTargets, SlaError } from "../server/sla-clocks.mjs";

const HOUR = 3600000, MIN = 60000;
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0); // fixed clock, no real time
const iso = ms => new Date(ms).toISOString();

// One assess-shaped thread: events are [id, offsetMsBeforeNow, direction].
const thread = (threadId, channel, events) => ({ threadId, channel,
  messages: events.map(([id, offsetMs, direction]) =>
    ({ id, occurredAt: iso(NOW - offsetMs), direction })) });

// --- percentile math -------------------------------------------------------

test("responseTimePercentiles: nearest-rank p50/p95/p99", () => {
  const out = responseTimePercentiles([10, 20, 30, 40]);
  assert.equal(out.count, 4);
  assert.equal(out.p50Ms, 20); // ceil(0.5*4)=2nd
  assert.equal(out.p95Ms, 40); // ceil(0.95*4)=4th
  assert.equal(out.p99Ms, 40);
});

test("responseTimePercentiles: single sample and empty", () => {
  assert.deepEqual(responseTimePercentiles([42]), { count: 1, p50Ms: 42, p95Ms: 42, p99Ms: 42 });
  assert.deepEqual(responseTimePercentiles([]), { count: 0, p50Ms: null, p95Ms: null, p99Ms: null });
});

test("responseTimePercentiles: rounds fractional ms and sorts", () => {
  const out = responseTimePercentiles([90.7, 10.2]);
  assert.equal(out.count, 2);
  assert.equal(out.p50Ms, 10); // ceil(0.5*2)=1st of sorted
  assert.equal(out.p95Ms, 91); // ceil(0.95*2)=2nd, rounded
});

test("responseTimePercentiles: rejects bad samples", () => {
  for (const bad of [[-1], ["60"], [NaN], [Infinity], "60", null])
    assert.throws(() => responseTimePercentiles(bad), SlaDashboardError);
});

// --- severity bands ----------------------------------------------------------

test("severityFor: low/medium/high/critical bands", () => {
  const target = 2 * HOUR;
  assert.equal(severityFor({ elapsedMs: MIN, targetMs: target, status: "on_track" }), "low");
  assert.equal(severityFor({ elapsedMs: 1.5 * HOUR, targetMs: target, status: "at_risk" }), "medium");
  assert.equal(severityFor({ elapsedMs: 1.2 * target, targetMs: target, status: "breached" }), "high");
  assert.equal(severityFor({ elapsedMs: 2 * target, targetMs: target, status: "breached" }), "critical");
  assert.equal(severityFor({ elapsedMs: 5 * target, targetMs: target, status: "breached" }), "critical");
  assert.equal(criticalAtRatio, 2);
  assert.deepEqual([...slaSeverities], ["low", "medium", "high", "critical"]);
});

// --- breach aggregation ------------------------------------------------------

test("buildSlaDashboard: breach counts by channel and severity", () => {
  const dashboard = buildSlaDashboard({
    now: NOW,
    targets: slaTargets,
    threads: [
      thread("t-high", "telegram", [["m1", 1.2 * 2 * HOUR, "inbound"]]), // breached 1.2x -> high
      thread("t-crit", "telegram", [["m1", 3 * 2 * HOUR, "inbound"]]),    // breached 3x -> critical
      thread("e-risk", "email", [["m1", 0.8 * 24 * HOUR, "inbound"]]),   // at_risk -> not a breach
      thread("e-high", "email", [["m1", 1.1 * 24 * HOUR, "inbound"]]),    // breached 1.1x -> high
    ],
  });
  assert.equal(dashboard.breaches.total, 3);
  assert.deepEqual(dashboard.breaches.byChannel, { telegram: 2, email: 1 });
  assert.deepEqual(dashboard.breaches.bySeverity, { high: 2, critical: 1 });
  assert.equal(dashboard.atRisk.total, 1);
  assert.deepEqual(dashboard.atRisk.byChannel, { email: 1 });
  assert.equal(dashboard.generatedAt, iso(NOW));
  assert.equal(dashboard.threadCount, 4);
});

test("buildSlaDashboard: percentiles measure answered threads per channel", () => {
  const dashboard = buildSlaDashboard({
    now: NOW,
    targets: slaTargets,
    threads: [
      thread("t1", "telegram", [["m1", 90 * MIN, "inbound"], ["m2", 60 * MIN, "outbound"]]), // 30min TTFR
      thread("t2", "telegram", [["m1", 200 * MIN, "inbound"], ["m2", 110 * MIN, "outbound"]]), // 90min TTFR
      thread("e1", "email", [["m1", 5 * HOUR, "inbound"], ["m2", 3 * HOUR, "outbound"]]), // 2h TTFR
      thread("t3", "telegram", [["m1", 10 * MIN, "inbound"]]), // still waiting: no percentile, counts as open
    ],
  });
  assert.deepEqual(dashboard.percentiles.telegram, { count: 2, p50Ms: 30 * MIN, p95Ms: 90 * MIN, p99Ms: 90 * MIN });
  assert.deepEqual(dashboard.percentiles.email, { count: 1, p50Ms: 2 * HOUR, p95Ms: 2 * HOUR, p99Ms: 2 * HOUR });
  assert.equal(dashboard.openCount, 1);
  assert.deepEqual(dashboard.openByChannel, { telegram: 1 });
  // status rollup sees every assessment
  assert.equal(dashboard.statusByChannel.telegram.responded, 2);
  assert.equal(dashboard.statusByChannel.telegram.on_track, 1);
});

// --- unowned end-of-day sweep --------------------------------------------------

test("buildSlaDashboard: sweep lists only unowned, still-waiting threads, worst first", () => {
  const owners = new Map([["owned", "agent-x"]]);
  const dashboard = buildSlaDashboard({
    now: NOW,
    targets: slaTargets,
    owners,
    threads: [
      thread("crit", "telegram", [["m1", 3 * 2 * HOUR, "inbound"]]),     // critical, longest
      thread("high", "telegram", [["m1", 1.5 * 2 * HOUR, "inbound"]]),   // high
      thread("med", "email", [["m1", 0.9 * 24 * HOUR, "inbound"]]),      // medium (at_risk)
      thread("low", "email", [["m1", 1 * HOUR, "inbound"]]),             // low (on_track)
      thread("owned", "telegram", [["m1", 4 * 2 * HOUR, "inbound"]]),    // breached but owned -> excluded
      thread("answered", "telegram", [["m1", 90 * MIN, "inbound"], ["m2", 60 * MIN, "outbound"]]), // not open -> excluded
    ],
  });
  const order = dashboard.openSweep.map(entry => entry.threadId);
  assert.deepEqual(order, ["crit", "high", "med", "low"]);
  for (const entry of dashboard.openSweep) {
    assert.equal(entry.owner, null);
    assert.ok(entry.awaitingSince && entry.deadlineAt);
    assert.ok(typeof entry.elapsedMs === "number" && typeof entry.targetMs === "number");
  }
  assert.equal(dashboard.openSweep[0].severity, "critical");
  assert.equal(dashboard.openSweep[1].severity, "high");
  assert.equal(dashboard.openSweep[2].severity, "medium");
  assert.equal(dashboard.openSweep[3].severity, "low");
});

test("buildSlaDashboard: sweep sorts longest wait first within a severity", () => {
  const dashboard = buildSlaDashboard({
    now: NOW,
    targets: slaTargets,
    threads: [
      thread("newer", "telegram", [["m1", 1.1 * 2 * HOUR, "inbound"]]),
      thread("older", "telegram", [["m1", 1.8 * 2 * HOUR, "inbound"]]),
    ],
  });
  assert.deepEqual(dashboard.openSweep.map(entry => entry.threadId), ["older", "newer"]);
  assert.ok(dashboard.openSweep.every(entry => entry.severity === "high"));
});

test("buildSlaDashboard: empty store scans to an honest empty dashboard", () => {
  const dashboard = buildSlaDashboard({ now: NOW, targets: slaTargets, threads: [] });
  assert.equal(dashboard.threadCount, 0);
  assert.equal(dashboard.openCount, 0);
  assert.deepEqual(dashboard.percentiles, {});
  assert.equal(dashboard.breaches.total, 0);
  assert.deepEqual(dashboard.openSweep, []);
});

// --- journaled breach alerts ---------------------------------------------------

test("buildSlaDashboard: journaled alerts roll up by channel", () => {
  const dashboard = buildSlaDashboard({
    now: NOW,
    targets: slaTargets,
    threads: [thread("t1", "telegram", [["m1", 10 * MIN, "inbound"]])],
    breachAlerts: [
      { threadId: "t1", channel: "telegram", kind: "sla_breach" },
      { threadId: "e9", channel: "email", kind: "sla_breach" },
      { threadId: "e10", channel: "email", kind: "sla_breach" },
    ],
  });
  assert.deepEqual(dashboard.journaledAlerts, { total: 3, byChannel: { telegram: 1, email: 2 } });
});

// --- input validation ----------------------------------------------------------

test("buildSlaDashboard: rejects malformed inputs", () => {
  const good = { now: NOW, targets: slaTargets, threads: [] };
  assert.throws(() => buildSlaDashboard({ ...good, threads: "nope" }), SlaDashboardError);
  assert.throws(() => buildSlaDashboard({ ...good, now: -1 }), SlaDashboardError);
  assert.throws(() => buildSlaDashboard({ ...good, owners: { t1: "x" } }), SlaDashboardError);
  assert.throws(() => buildSlaDashboard({ ...good, owners: new Map([[1, "x"]]) }), SlaDashboardError);
  assert.throws(() => buildSlaDashboard({ ...good, breachAlerts: [{ threadId: "t" }] }), SlaDashboardError);
  assert.throws(() => buildSlaDashboard({ ...good, breachAlerts: "nope" }), SlaDashboardError);
  // A now that precedes the latest inbound is a clock skew: the reused
  // clocks surface their own SlaError, which the dashboard propagates.
  assert.throws(() => buildSlaDashboard({ ...good,
    threads: [thread("t", "telegram", [["m1", 10 * MIN, "inbound"]])], now: NOW - 60 * MIN }), SlaError);
});

test("severityFor: rejects bad inputs", () => {
  assert.throws(() => severityFor({ elapsedMs: -1, targetMs: 1000, status: "breached" }), SlaDashboardError);
  assert.throws(() => severityFor({ elapsedMs: 1, targetMs: 0, status: "breached" }), SlaDashboardError);
});
