// tests/tripwires.test.mjs — WAVE-300 Worker B: server-side trip-wire gauges.
//
// Fail-first coverage for server/tripwires.mjs + the GET /api/health/tripwires
// endpoint wiring in server/http.mjs:
// - gauge threshold transitions ok -> warn -> critical (both directions)
// - write-limiter penalty counter 15-minute windowing
// - commands silent-timeout ratio math
// - silent-timeout detection via the response close listener
// - the HTTP endpoint returns JSON with all 5 gauges
//
// Load-bearing constraint under test: the gauges never emit room events and
// never write on a read path (pure in-memory registry; store reads only on
// the slow collect() tick).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";

import {
  createTripwires,
  gaugeStatus,
  eventBudgetRemainingRatio,
  projectionBytesRatio,
  silentTimeoutRatio,
  PENALTY_WINDOW_MS,
} from "../server/tripwires.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const LIMITS = { eventsPerRoom: 1000, projectionBytes: 1000 };

function controllableClock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: ms => { t += ms; } };
}

function fakeMonitor(p99) {
  return { percentile: () => p99, resetCalls: 0, disabled: false,
    reset() { this.resetCalls++; }, disable() { this.disabled = true; } };
}

// A minimal store double: collect() runs exactly one SQL read against it.
function fakeStore(rows) {
  return { db: { prepare: sql => {
    assert.match(sql, /FROM rooms/, "collect() must read the rooms table");
    return { all: () => rows };
  } } };
}

test("gaugeStatus: high-is-bad transitions ok -> warn -> critical", () => {
  const def = { direction: "high", warnAt: 0.1, criticalAt: 0.3 };
  assert.equal(gaugeStatus(def, 0.05), "ok");
  assert.equal(gaugeStatus(def, 0.1), "ok", "warn trips only ABOVE warnAt");
  assert.equal(gaugeStatus(def, 0.11), "warn");
  assert.equal(gaugeStatus(def, 0.3), "warn", "critical trips only ABOVE criticalAt");
  assert.equal(gaugeStatus(def, 0.31), "critical");
});

test("gaugeStatus: low-is-bad transitions ok -> warn -> critical", () => {
  const def = { direction: "low", warnAt: 0.2, criticalAt: 0.1 };
  assert.equal(gaugeStatus(def, 0.5), "ok");
  assert.equal(gaugeStatus(def, 0.2), "ok", "warn trips only BELOW warnAt");
  assert.equal(gaugeStatus(def, 0.15), "warn");
  assert.equal(gaugeStatus(def, 0.1), "warn", "critical trips only BELOW criticalAt");
  assert.equal(gaugeStatus(def, 0.05), "critical");
});

test("gaugeStatus: non-numeric value is unknown, never a fake ok", () => {
  assert.equal(gaugeStatus({ direction: "high", warnAt: 1, criticalAt: 2 }, null), "unknown");
  assert.equal(gaugeStatus({ direction: "high", warnAt: 1, criticalAt: 2 }, Number.NaN), "unknown");
});

test("gaugeStatus: inclusive defs trip AT the threshold (>= / <=)", () => {
  const def = { direction: "high", warnAt: 5, criticalAt: 20, inclusive: true };
  assert.equal(gaugeStatus(def, 4), "ok");
  assert.equal(gaugeStatus(def, 5), "warn");
  assert.equal(gaugeStatus(def, 20), "critical");
  const low = { direction: "low", warnAt: 0.2, criticalAt: 0.1, inclusive: true };
  assert.equal(gaugeStatus(low, 0.2), "warn");
  assert.equal(gaugeStatus(low, 0.1), "critical");
});

test("eventBudgetRemainingRatio: worst room wins; empty store reads as full", () => {
  assert.equal(eventBudgetRemainingRatio([], 1000), 1);
  assert.equal(eventBudgetRemainingRatio([{ sequence: 500 }], 1000), 0.5);
  assert.equal(
    eventBudgetRemainingRatio([{ sequence: 100 }, { sequence: 950 }], 1000),
    0.05,
    "the most-consumed room drives the gauge"
  );
  assert.equal(eventBudgetRemainingRatio([{ sequence: 1200 }], 1000), 0, "clamped at zero past the limit");
});

test("event budget gauge transitions ok -> warn -> critical via collect()", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    tw.collect(fakeStore([{ sequence: 500 }]));
    assert.equal(tw.gauge("event_budget_remaining_ratio").status, "ok");
    tw.collect(fakeStore([{ sequence: 850 }])); // 0.15 remaining
    assert.equal(tw.gauge("event_budget_remaining_ratio").status, "warn");
    tw.collect(fakeStore([{ sequence: 950 }])); // 0.05 remaining
    const g = tw.gauge("event_budget_remaining_ratio");
    assert.equal(g.status, "critical");
    assert.equal(g.value, 0.05);
  } finally { tw.stop(); }
});

test("projectionBytesRatio: max room wins; empty store reads as zero", () => {
  assert.equal(projectionBytesRatio([], 1000), 0);
  assert.equal(projectionBytesRatio([{ projectionBytes: 800 }], 1000), 0.8);
  assert.equal(
    projectionBytesRatio([{ projectionBytes: 100 }, { projectionBytes: 950 }], 1000),
    0.95,
    "the largest projection drives the gauge"
  );
});

test("projection gauge transitions ok -> warn -> critical via collect()", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    tw.collect(fakeStore([{ sequence: 1, projectionBytes: 500 }]));
    assert.equal(tw.gauge("projection_bytes_ratio").status, "ok");
    tw.collect(fakeStore([{ sequence: 1, projectionBytes: 800 }]));
    assert.equal(tw.gauge("projection_bytes_ratio").status, "warn");
    tw.collect(fakeStore([{ sequence: 1, projectionBytes: 950 }]));
    const g = tw.gauge("projection_bytes_ratio");
    assert.equal(g.status, "critical");
    assert.equal(g.value, 0.95);
  } finally { tw.stop(); }
});

test("penalty counter: warn at >= 5, critical at >= 20 entries in the window", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    for (let i = 0; i < 4; i++) tw.recordWriteLimiterPenalty();
    let g = tw.gauge("write_limiter_penalty_entries");
    assert.equal(g.value, 4);
    assert.equal(g.status, "ok");
    tw.recordWriteLimiterPenalty();
    g = tw.gauge("write_limiter_penalty_entries");
    assert.equal(g.value, 5);
    assert.equal(g.status, "warn");
    for (let i = 0; i < 15; i++) tw.recordWriteLimiterPenalty();
    g = tw.gauge("write_limiter_penalty_entries");
    assert.equal(g.value, 20);
    assert.equal(g.status, "critical");
  } finally { tw.stop(); }
});

test("penalty counter: entries expire after the 15-minute rolling window", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    for (let i = 0; i < 6; i++) tw.recordWriteLimiterPenalty();
    assert.equal(tw.gauge("write_limiter_penalty_entries").status, "warn");
    clock.advance(PENALTY_WINDOW_MS + 1);
    tw.collect(fakeStore([])); // the slow tick prunes even with no new penalties
    const g = tw.gauge("write_limiter_penalty_entries");
    assert.equal(g.value, 0);
    assert.equal(g.status, "ok", "a quiet period decays the gauge back to ok");
  } finally { tw.stop(); }
});

test("silentTimeoutRatio: timeouts over total outcomes; empty is zero", () => {
  assert.equal(silentTimeoutRatio([]), 0);
  assert.equal(silentTimeoutRatio(["ok", "ok", "429", "5xx"]), 0);
  assert.equal(silentTimeoutRatio(["ok", "timeout"]), 0.5);
});

test("commands silent-timeout gauge transitions ok -> warn -> critical", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    for (let i = 0; i < 9; i++) tw.recordCommandOutcome("ok");
    tw.recordCommandOutcome("timeout"); // 1/10 = 0.1 -> ok (warn is > 0.1)
    assert.equal(tw.gauge("commands_silent_timeout_ratio").status, "ok");
    tw.recordCommandOutcome("timeout"); // 2/11 ≈ 0.18 -> warn
    assert.equal(tw.gauge("commands_silent_timeout_ratio").status, "warn");
    tw.recordCommandOutcome("timeout");
    tw.recordCommandOutcome("timeout"); // 4/13 ≈ 0.31 -> critical
    const g = tw.gauge("commands_silent_timeout_ratio");
    assert.equal(g.status, "critical");
    assert.ok(Math.abs(g.value - 4 / 13) < 1e-12);
  } finally { tw.stop(); }
});

test("event loop p99 gauge samples then resets the monitor each tick", () => {
  const clock = controllableClock();
  const monitor = fakeMonitor(250);
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: monitor });
  try {
    tw.collect(fakeStore([]));
    const g = tw.gauge("event_loop_delay_ms_p99");
    assert.equal(g.value, 250);
    assert.equal(g.status, "critical");
    assert.equal(monitor.resetCalls, 1, "each tick measures its own window");
  } finally { tw.stop(); }
  assert.equal(monitor.disabled, true, "stop() disables the monitor");
});

test("event loop gauge: null monitor degrades to the neutral default, no throw", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    tw.collect(fakeStore([]));
    const g = tw.gauge("event_loop_delay_ms_p99");
    assert.equal(typeof g.value, "number");
    assert.equal(g.status, "ok");
  } finally { tw.stop(); }
});

function fakeResponse() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.once = res.once.bind(res);
  return res;
}

test("trackCommandOutcome: silent close with no response records a timeout", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    const res = fakeResponse();
    tw.trackCommandOutcome(res);
    res.emit("close"); // connection died before any response was written
    assert.equal(tw.gauge("commands_silent_timeout_ratio").value, 1);
  } finally { tw.stop(); }
});

test("trackCommandOutcome: a recorded outcome is never overwritten by close", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    const res = fakeResponse();
    const tracker = tw.trackCommandOutcome(res);
    tracker.record("ok");
    res.writableEnded = true;
    res.emit("close");
    const g = tw.gauge("commands_silent_timeout_ratio");
    assert.equal(g.value, 0, "the ok outcome stands; no phantom timeout");
  } finally { tw.stop(); }
});

test("snapshot: registry shape carries all 5 gauges", () => {
  const clock = controllableClock();
  const tw = createTripwires({ now: clock.now, limits: LIMITS, eventLoopMonitor: null });
  try {
    const snap = tw.snapshot();
    const names = snap.gauges.map(g => g.name).sort();
    assert.deepEqual(names, [
      "commands_silent_timeout_ratio",
      "event_budget_remaining_ratio",
      "event_loop_delay_ms_p99",
      "projection_bytes_ratio",
      "write_limiter_penalty_entries",
    ]);
    for (const g of snap.gauges) {
      assert.equal(typeof g.value, "number", `${g.name}.value`);
      assert.equal(typeof g.warnAt, "number", `${g.name}.warnAt`);
      assert.equal(typeof g.criticalAt, "number", `${g.name}.criticalAt`);
      assert.ok(["ok", "warn", "critical", "unknown"].includes(g.status), `${g.name}.status`);
      assert.equal(typeof g.updatedAt, "number", `${g.name}.updatedAt`);
    }
    assert.equal(typeof snap.updatedAt, "number");
  } finally { tw.stop(); }
});

test("GET /api/health/tripwires returns JSON with all 5 gauges", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/api/health/tripwires`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  const names = body.gauges.map(g => g.name).sort();
  assert.deepEqual(names, [
    "commands_silent_timeout_ratio",
    "event_budget_remaining_ratio",
    "event_loop_delay_ms_p99",
    "projection_bytes_ratio",
    "write_limiter_penalty_entries",
  ]);
  for (const g of body.gauges) {
    assert.equal(typeof g.value, "number");
    assert.ok(["ok", "warn", "critical", "unknown"].includes(g.status));
  }
});
