// Scheduler invariants — fail-first regression tests for guild-16 mutation
// survivors. Each test FAILS on the corresponding jobs.mjs / growth-scheduler.js
// mutant and PASSES on the original. Covers: at-most-once per tick, lastRan
// advancement (no hot loops), due-boundary exactness, slow-job alarm exclusion,
// start() idempotence, fail-closed gates, failure record-keeping.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  JOBS, jobByName, jobEnabled, jobNextDue, jobIsDue, earliestFutureAlarm,
  startNodeScheduler, wireNodeJobs, MINUTE_MS, HOUR_MS,
} from "../server/jobs.mjs";
import { createScheduler } from "../src/growth-scheduler.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, ".tmp", "jobs-invariants");
mkdirSync(TMP, { recursive: true });

const integrity = jobByName("integrity");
const webhook = jobByName("webhook-dispatch");
const retention = jobByName("retention");

// A store whose every query returns "nothing waiting".
function emptyStore() {
  return {
    db: { prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }) },
    agentPlugin: { setDispatchKick() {}, pruneWebhookDeliveries: () => ({ deleted: 0 }), drainWebhookDeliveries: async () => ({}) },
  };
}

function roomStore() {
  const dir = mkdtempSync(join(TMP, "s-"));
  const store = new RoomStore(join(dir, "room.sqlite"), {});
  store.initialize(initialRoom("commons"));
  return { dir, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("concurrent runOnce calls run each due job at most once (reentrancy guard)", async () => {
  const { store, close } = roomStore();
  let runs = 0, release;
  const gate = new Promise(r => { release = r; });
  const orig = store.verifyRoomIntegrity.bind(store);
  store.verifyRoomIntegrity = async args => { runs += 1; await gate; return orig(args); };
  // make integrity due: clock far past its hourly cadence
  let clock = 10 * HOUR_MS;
  const sched = startNodeScheduler({ store, env: { GROWTH_WATCH_INTERVAL_MS: "0" }, now: () => clock, tickMs: 0 });
  try {
    const p1 = sched.runOnce();
    const p2 = sched.runOnce();
    await new Promise(r => setTimeout(r, 50)); // let the also-ran hit the guard
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    const empties = [r1, r2].filter(r => Array.isArray(r) && r.length === 0).length;
    assert.equal(runs, 1, `integrity ran ${runs}x under concurrent ticks`);
    assert.equal(empties, 1, "exactly one concurrent tick must return []");
  } finally { sched.stop(); close(); }
});

test("lastRan advances on success: no every-tick rerun (cadence memory)", async () => {
  const { store, close } = roomStore();
  let runs = 0;
  const orig = store.verifyRoomIntegrity.bind(store);
  store.verifyRoomIntegrity = async args => { runs += 1; return orig(args); };
  let clock = 10 * HOUR_MS;
  const sched = startNodeScheduler({ store, env: { GROWTH_WATCH_INTERVAL_MS: "0" }, now: () => clock, tickMs: 0 });
  try {
    await sched.runOnce();
    assert.equal(runs, 1);
    clock += 1000; // 1s later — far short of the hourly cadence
    await sched.runOnce();
    assert.equal(runs, 1, `integrity re-ran ${runs}x after 1s (lastRan not advanced)`);
  } finally { sched.stop(); close(); }
});

test("jobNextDue falls back to lastRan + cadenceMs (no immediate-loop)", () => {
  const now = 10 * HOUR_MS, last = now - HOUR_MS;
  const next = jobNextDue(integrity, emptyStore(), now, last);
  assert.equal(next, last + integrity.cadenceMs);
  assert.ok(next > now - integrity.cadenceMs, "next due must include the cadence");
});

test("webhook-dispatch stays disabled when nothing is due (null, not 0)", () => {
  const store = emptyStore();
  assert.equal(jobEnabled(webhook, {}, store), false);
  assert.equal(jobNextDue(webhook, store, Date.now(), undefined), null);
});

test("a job returning {errors:1} without scanError is recorded as failed", async () => {
  const { store, close } = roomStore();
  const orig = store.verifyRoomIntegrity.bind(store);
  store.verifyRoomIntegrity = async () => { throw new Error("boom"); };
  void orig;
  let clock = 10 * HOUR_MS;
  const sched = startNodeScheduler({ store, env: { GROWTH_WATCH_INTERVAL_MS: "0" }, now: () => clock, tickMs: 0 });
  try {
    await sched.runOnce(); // integrity catches its own throw -> {errors:1}
    const h = sched.jobHealth().find(j => j.name === "integrity");
    assert.equal(h.consecutiveFailures, 1, "errors:1 must bump consecutiveFailures");
    assert.ok(h.lastErrorAt, "lastErrorAt must be set");
  } finally { sched.stop(); close(); }
});

test("slow jobs never arm the worker alarm, even when due sooner than fast jobs", () => {
  const now = 10 * HOUR_MS;
  // synthetic slow job due in 1s via nextDueAt — must still not arm the alarm
  const fakeSlow = {
    name: "fake-slow", slow: true, runtimes: ["worker"], cadenceMs: HOUR_MS,
    enabled: () => true, nextDueAt: (store, n) => n + 1000,
  };
  const lastRan = { retention: 0, integrity: 0 }; // long overdue
  const alarm = earliestFutureAlarm([...JOBS, fakeSlow], { env: {}, store: emptyStore(), now, lastRan, runtime: "worker" });
  assert.equal(alarm, now + MINUTE_MS, `slow jobs must not arm the alarm (got ${alarm})`);
});

test("a past-due job pushes the alarm out by one cadence, never to now", () => {
  const now = 10 * HOUR_MS;
  const store = {
    db: { prepare: sql => ({ get: () => sql.includes("agent_webhook_deliveries") ? { due: now - 5000 } : null, all: () => [], run: () => ({}) }) },
  };
  const alarm = earliestFutureAlarm(JOBS, { env: {}, store, now, lastRan: {}, runtime: "worker" });
  assert.ok(alarm > now, `alarm ${alarm} must be strictly after now ${now}`);
  assert.equal(alarm, now + webhook.cadenceMs);
});

test("jobIsDue is true at exactly lastRan + cadence (boundary inclusive)", () => {
  const last = 1000000;
  assert.equal(jobIsDue(integrity, null, last + integrity.cadenceMs, last), true);
  assert.equal(jobIsDue(integrity, null, last + integrity.cadenceMs - 1, last), false);
});

test("jobIsDue is true when nextDueAt equals now exactly (nextDueAt path)", () => {
  const now = 5000000;
  const store = {
    db: { prepare: sql => ({ get: () => sql.includes("agent_webhook_deliveries") ? { due: now } : null, all: () => [], run: () => ({}) }) },
  };
  assert.equal(jobIsDue(webhook, store, now, undefined), true, "due==now must count as due");
});

test("GROWTH_WATCH_INTERVAL_MS=0 disables growth (not enabled with 0ms)", () => {
  const sched = startNodeScheduler({ store: emptyStore(), env: { GROWTH_WATCH_INTERVAL_MS: "0" }, tickMs: 0 });
  try {
    assert.equal(sched.growthEnabled, false, "interval 0 must disable growth, not hot-loop it");
  } finally { sched.stop(); }
});

test("wireNodeJobs starts the scheduler", () => {
  const { store, close } = roomStore();
  const sched = wireNodeJobs(store, { env: { GROWTH_WATCH_INTERVAL_MS: "0" }, tickMs: 60000, now: () => Date.now() });
  try {
    assert.equal(sched.isRunning(), true, "wireNodeJobs must start the scheduler");
  } finally { sched.stop(); close(); }
});

test("node start() twice arms exactly one timer (no double tick)", () => {
  const sched = startNodeScheduler({ store: emptyStore(), tickMs: 60000 });
  const origSet = global.setInterval;
  let calls = 0;
  global.setInterval = (...args) => { calls += 1; return origSet(...args); };
  try {
    sched.start();
    sched.start();
    assert.equal(calls, 1, `start() twice armed ${calls} timers`);
    assert.equal(sched.isRunning(), true);
  } finally {
    global.setInterval = origSet;
    sched.stop();
  }
  assert.equal(sched.isRunning(), false);
});

test("growth-scheduler runTick tolerates null and malformed tick results", async () => {
  for (const tick of [() => null, () => ({ triggered: null }), () => ({ triggered: "x" })]) {
    const s = createScheduler({ watcher: { tick }, intervalMs: 5, onAlert: () => {} });
    s.start();
    await new Promise(r => setTimeout(r, 60));
    s.stop();
    assert.ok(s.getTickCount() >= 1, "tick must be counted despite malformed result");
  }
  assert.ok(retention.slow, "retention is a slow job");
});
