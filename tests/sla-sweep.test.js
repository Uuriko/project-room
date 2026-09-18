// SLA sweep/scheduler. Unit tests: live threads feed the breach producer,
// urgent records route through decideNotification with urgent=true (quiet
// hours bypassed, muted-all respected), dedupe/re-breach follow the producer
// ledger, missing authority is an honest deferral, failing readers/delivers
// never kill the tick, and the scheduler follows the repo pattern (unref'd
// interval, start/stop, never-die ticks, no stacking).
import test from "node:test";
import assert from "node:assert/strict";
import { SlaSweeper, createSlaSweepScheduler, slaSweepLimits, SlaSweepError, SLA_BREACH_KIND } from "../server/sla-sweep.mjs";
import { createNotifyPrefs } from "../server/notify-prefs.mjs";
import { createSlaBreachProducer } from "../server/sla-urgent-notify.mjs";

const throwsSweep = (fn, code) => assert.throws(fn, err => err instanceof SlaSweepError && err.code === code);
const HOUR = 3600000;
const at = hours => new Date(Date.UTC(2026, 8, 18, 0, 0, 0) + hours * HOUR).toISOString();
const NOW = Date.parse(at(10)); // 10:00 UTC
const inbound = (id, hours) => ({ id, occurredAt: at(hours), direction: "inbound" });
const outbound = (id, hours) => ({ id, occurredAt: at(hours), direction: "outbound" });
const thread = (threadId, channel, messages) => ({ threadId, channel, messages });

// A telegram thread whose inbound waited 3h against the 2h target: breached.
const breachedTelegram = () => thread("t1", "telegram", [inbound("m1", 7)]);
// A telegram thread answered within target: healthy.
const answeredTelegram = () => thread("t2", "telegram", [inbound("m1", 9), outbound("m2", 9.5)]);

function harness({ threads = [], prefs = null, deliver = null, readThreads = null, now = () => NOW, ...rest } = {}) {
  const seen = [];
  const prefsStore = prefs ?? createNotifyPrefs();
  const sweeper = new SlaSweeper({
    readThreads: readThreads ?? (async () => threads),
    deliver: deliver ?? (async (record, decision) => { seen.push({ record, decision }); }),
    notifyPrefs: prefsStore,
    ownerId: "owner-1",
    now,
    ...rest,
  });
  return { sweeper, seen, prefs: prefsStore };
}

// --- breach detection: live threads feed produce() ---------------------------
test("a breached live thread produces one urgent record and delivers it", async () => {
  const { sweeper, seen } = harness({ threads: [breachedTelegram(), answeredTelegram()] });
  const summary = await sweeper.tick();
  assert.ok(Object.isFrozen(summary), "summaries are frozen");
  assert.equal(summary.kind, SLA_BREACH_KIND);
  assert.equal(summary.threads, 2);
  assert.equal(summary.produced, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.muted, 0); assert.equal(summary.deferred, 0); assert.equal(summary.errors, 0);
  assert.equal(summary.scanError, null);
  assert.equal(summary.active, 1);
  assert.equal(seen.length, 1);
  const { record, decision } = seen[0];
  assert.equal(record.threadId, "t1");
  assert.equal(record.urgent, true);
  assert.equal(record.channel, "telegram");
  assert.equal(decision.decision, "deliver");
  assert.deepEqual(sweeper.activeAlerts().map(r => r.threadId), ["t1"]);
  assert.equal(sweeper.lastTick, summary);
});

// --- urgent bypasses quiet hours ---------------------------------------------
test("urgent bypasses quiet hours: a breach inside the window still delivers", async () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("owner-1", { start: "09:00", end: "11:00", tz: "UTC" });
  const { sweeper, seen } = harness({ threads: [breachedTelegram()], prefs });
  const summary = await sweeper.tick();
  assert.equal(summary.delivered, 1, "urgent overrides quiet hours");
  assert.equal(seen[0].decision.decision, "deliver");
  assert.match(seen[0].decision.reason, /urgent/i);
});

// --- explicit muted-all is respected ------------------------------------------
test("an explicit muted-all choice mutes even urgent breach records", async () => {
  const prefs = createNotifyPrefs();
  prefs.setQuietHours("owner-1", { start: "09:00", end: "11:00", tz: "UTC" });
  prefs.setGlobal("owner-1", { level: "muted" });
  const { sweeper, seen } = harness({ threads: [breachedTelegram()], prefs });
  const summary = await sweeper.tick();
  assert.equal(summary.delivered, 0, "no delivery under muted-all");
  assert.equal(summary.muted, 1);
  assert.equal(seen.length, 0);
  assert.equal(summary.results[0].status, "muted");
  assert.equal(summary.active, 1, "the breach stays active in the ledger while muted");
});

// --- healthy threads stay silent -----------------------------------------------
test("a healthy sweep produces and delivers nothing", async () => {
  const { sweeper, seen } = harness({ threads: [answeredTelegram()] });
  const summary = await sweeper.tick();
  assert.equal(summary.produced, 0); assert.equal(summary.delivered, 0);
  assert.deepEqual(seen, []);
  assert.deepEqual(summary.results, []);
});

// --- dedupe: one alert per breach, re-alert on re-breach -----------------------
test("a persistent breach delivers once across ticks", async () => {
  const { sweeper, seen } = harness({ threads: [breachedTelegram()] });
  await sweeper.tick();
  const again = await sweeper.tick();
  assert.equal(again.produced, 0, "the same unanswered breach does not re-page");
  assert.equal(seen.length, 1);
});

test("answering then re-breaching delivers again", async () => {
  let current = [breachedTelegram()];
  // now sits 4h after the baseline so the later inbound (11.5h) is in the past.
  const { sweeper, seen } = harness({ readThreads: async () => current, now: () => NOW + 4 * HOUR });
  await sweeper.tick();
  current = [thread("t1", "telegram", [inbound("m1", 7), outbound("m2", 10.5)])];
  await sweeper.tick();
  current = [thread("t1", "telegram", [inbound("m1", 7), outbound("m2", 10.5), inbound("m3", 11.5)])];
  const rebreach = await sweeper.tick();
  assert.equal(rebreach.produced, 1);
  assert.equal(seen.length, 2, "the new unanswered inbound pages again");
  assert.equal(seen[1].record.threadId, "t1");
});

test("clearAlert lets a still-breached thread re-alert on the next tick", async () => {
  const { sweeper, seen } = harness({ threads: [breachedTelegram()] });
  await sweeper.tick();
  assert.equal(sweeper.clearAlert("t1"), true);
  const summary = await sweeper.tick();
  assert.equal(summary.produced, 1);
  assert.equal(seen.length, 2);
});

// --- honest unavailability ------------------------------------------------------
test("without a readThreads authority the tick defers honestly instead of inventing threads", async () => {
  const sweeper = new SlaSweeper({ ownerId: "owner-1", now: () => NOW, deliver: async () => {} });
  const summary = await sweeper.tick();
  assert.match(summary.scanError ?? "", /sla_sweep_unavailable/);
  assert.equal(summary.produced, 0); assert.equal(summary.delivered, 0);
});

test("without a deliver hook alerts are produced but deferred, and stay active", async () => {
  const { sweeper } = harness({ threads: [breachedTelegram()], deliver: null });
  const summary = await new SlaSweeper({ readThreads: async () => [breachedTelegram()],
    notifyPrefs: createNotifyPrefs(), ownerId: "owner-1", now: () => NOW }).tick();
  assert.equal(summary.produced, 1);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.results[0].status, "deferred");
  assert.equal(summary.results[0].code, "sla_deliver_unavailable");
  assert.equal(summary.active, 1, "dedupe still works: the ledger recorded the alert");
  assert.equal(sweeper.activeAlerts().length, 0, "sanity: the harness sweeper saw no threads");
});

// --- failures never kill the tick --------------------------------------------------
test("a failing reader surfaces as scanError, never throws", async () => {
  const { sweeper } = harness({ readThreads: async () => { throw Object.assign(new Error("boom"), { code: "reader_down" }); } });
  const summary = await sweeper.tick();
  assert.match(summary.scanError ?? "", /reader_down/);
  assert.equal(summary.produced, 0);
});

test("malformed threads surface as scanError from produce(), never throw", async () => {
  const { sweeper } = harness({ readThreads: async () => [{ threadId: "bad", channel: "telegram", messages: [{ id: "x" }] }] });
  const summary = await sweeper.tick();
  assert.ok(summary.scanError, "produce's validation surfaced as scanError");
});

test("a failing deliver is counted per record and the tick continues", async () => {
  const calls = [];
  const { sweeper } = harness({
    threads: [breachedTelegram(), thread("t9", "telegram", [inbound("m9", 6)])],
    deliver: async record => { calls.push(record.threadId); if (record.threadId === "t1") throw new Error("hook down"); },
  });
  const summary = await sweeper.tick();
  assert.equal(summary.produced, 2);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.results.find(r => r.threadId === "t1").status, "error");
  assert.equal(summary.results.find(r => r.threadId === "t9").status, "delivered");
});

// --- configuration ---------------------------------------------------------------
test("constructor validation rejects bad configuration with coded errors", () => {
  throwsSweep(() => new SlaSweeper({ ownerId: "" }), "invalid_sla_sweep");
  throwsSweep(() => new SlaSweeper({}), "invalid_sla_sweep");
  throwsSweep(() => new SlaSweeper({ ownerId: "o", targets: { telegram: { targetMs: -5 } } }), "invalid_sla_sweep");
  assert.throws(() => new SlaSweeper({ ownerId: "o", readThreads: "nope" }), TypeError);
  assert.throws(() => new SlaSweeper({ ownerId: "o", deliver: 42 }), TypeError);
  assert.throws(() => new SlaSweeper({ ownerId: "o", producer: createSlaBreachProducer(), targets: {} }), TypeError);
  assert.throws(() => new SlaSweeper({ ownerId: "o", notifyPrefs: {} }), TypeError);
});

test("injectable targets move the breach line", async () => {
  const { sweeper, seen } = harness({
    threads: [thread("t5", "telegram", [inbound("m5", 9.25)])], // 45m old: on_track under 2h, breached under 30m
    targets: { telegram: { targetMs: 30 * 60 * 1000, label: "30m" }, email: { targetMs: 24 * HOUR, label: "24h" } },
  });
  const summary = await sweeper.tick();
  assert.equal(summary.produced, 1);
  assert.equal(seen[0].record.targetMs, 30 * 60 * 1000);
});

test("an injected producer is used as-is", async () => {
  const producer = createSlaBreachProducer();
  const { sweeper, seen } = harness({ threads: [breachedTelegram()], producer });
  await sweeper.tick();
  assert.equal(seen.length, 1);
  assert.equal(producer.activeAlerts().length, 1, "the caller's ledger owns the alert");
});

// --- scheduler ----------------------------------------------------------------------
test("the sweep scheduler follows the repo pattern: unref'd interval, start/stop, never-die ticks", async () => {
  const { sweeper } = harness({ threads: [breachedTelegram()] });
  const seen = [];
  const scheduler = createSlaSweepScheduler({ sweeper, intervalMs: 20, onTick: summary => seen.push(summary) });
  assert.equal(scheduler.isRunning(), false);
  scheduler.start(); scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  await new Promise(resolve => setTimeout(resolve, 120));
  scheduler.stop(); scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  assert.ok(scheduler.getTickCount() >= 1, "ticks ran on the interval");
  assert.ok(seen.length >= 1 && seen.every(s => s.produced === 0 || s.delivered === 1), "ticks reported");
  assert.throws(() => createSlaSweepScheduler({ sweeper: {}, intervalMs: 20 }), TypeError);
  assert.throws(() => createSlaSweepScheduler({ sweeper, intervalMs: Number.NaN }), TypeError);
  const disabled = createSlaSweepScheduler({ sweeper, intervalMs: 0 });
  disabled.start(); assert.equal(disabled.isRunning(), false, "interval <= 0 disables the scheduler");
  assert.equal(slaSweepLimits.intervalMs, 5 * 60 * 1000, "default cadence pages within minutes, far below the 2h target");
});

test("a tick that throws is counted and never kills the scheduler", async () => {
  const bad = { tick: async () => { throw new Error("sweep exploded"); } };
  const scheduler = createSlaSweepScheduler({ sweeper: Object.assign(Object.create(SlaSweeper.prototype), bad), intervalMs: 20 });
  scheduler.start();
  await new Promise(resolve => setTimeout(resolve, 80));
  scheduler.stop();
  assert.ok(scheduler.getErrorCount() >= 1, "failed ticks are counted");
});

test("overlapping ticks never stack", async () => {
  let concurrent = 0, maxConcurrent = 0;
  const slow = new SlaSweeper({ ownerId: "o", now: () => NOW,
    readThreads: async () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 60)); concurrent--; return []; } });
  const scheduler = createSlaSweepScheduler({ sweeper: slow, intervalMs: 20 });
  scheduler.start();
  await new Promise(resolve => setTimeout(resolve, 150));
  scheduler.stop();
  assert.ok(maxConcurrent <= 1, "a slow tick skips a beat instead of stacking");
});
