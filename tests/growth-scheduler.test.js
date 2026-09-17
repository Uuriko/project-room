// Track C slice C13 — tests for src/growth-scheduler.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { createWatcher } from "../src/growth-watch.js";
import {
  createScheduler,
  defaultGrowthRules,
  defaultOnAlert,
  DEFAULT_INTERVAL_MS
} from "../src/growth-scheduler.js";

const HUMAN = { id: "human-1", kind: "human" };

const fakeWatcher = (tickImpl = () => ({ triggered: [], window: { since: "s", until: "u" } })) =>
  ({ tick: tickImpl });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Poll until cond() is true or timeout elapses. Fixed sleeps are flaky
// under a loaded event loop (the full `npm run check` suite); waiting on
// the actual condition keeps the test fast when idle and robust when busy.
const waitFor = async (cond, timeoutMs = 5000, stepMs = 10) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await sleep(stepMs);
  }
};

test("rejects invalid watcher, intervalMs and onAlert", () => {
  assert.throws(() => createScheduler(), TypeError);
  assert.throws(() => createScheduler({ watcher: null }), TypeError);
  assert.throws(() => createScheduler({ watcher: {} }), TypeError);
  assert.throws(() => createScheduler({ watcher: { tick: "x" } }), TypeError);
  assert.throws(() => createScheduler({ watcher: fakeWatcher(), intervalMs: Number.NaN }), TypeError);
  assert.throws(() => createScheduler({ watcher: fakeWatcher(), intervalMs: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => createScheduler({ watcher: fakeWatcher(), intervalMs: "300000" }), TypeError);
  assert.throws(() => createScheduler({ watcher: fakeWatcher(), onAlert: "x" }), TypeError);
});

test("start() is a no-op when intervalMs is 0 or negative (disabled)", () => {
  for (const intervalMs of [0, -1000]) {
    const s = createScheduler({ watcher: fakeWatcher(), intervalMs });
    s.start();
    assert.equal(s.isRunning(), false);
    assert.equal(s.getTickCount(), 0);
    assert.equal(s.getTimer(), null);
    s.stop(); // idempotent no-op
  }
});

test("start/stop are idempotent and isRunning tracks state", () => {
  const s = createScheduler({ watcher: fakeWatcher(), intervalMs: 50 });
  s.start();
  const first = s.getTimer();
  assert.equal(s.isRunning(), true);
  s.start();
  assert.equal(s.getTimer(), first, "second start must not replace the timer");
  s.stop();
  assert.equal(s.isRunning(), false);
  assert.equal(s.getTimer(), null);
  s.stop(); // must not throw
});

test("ticks the watcher on the interval", async () => {
  let calls = 0;
  const s = createScheduler({ watcher: fakeWatcher(() => { calls += 1; return { triggered: [], window: null }; }), intervalMs: 15 });
  s.start();
  await waitFor(() => calls >= 2);
  s.stop();
  assert.equal(s.getTickCount(), calls);
  const frozen = calls;
  await sleep(40);
  assert.equal(s.getTickCount(), frozen, "no ticks after stop");
});

test("a throwing watcher.tick is logged and counted; the scheduler survives", async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let calls = 0;
  try {
    const s = createScheduler({
      watcher: fakeWatcher(() => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { triggered: [], window: null };
      }),
      intervalMs: 15
    });
    s.start();
    await waitFor(() => calls >= 2);
    s.stop();
    assert.equal(s.getErrorCount(), 1);
    assert.equal(s.getTickCount(), calls - 1);
    assert.ok(warnings.some(line => line.includes("scheduler tick failed") && line.includes("boom")));
  } finally {
    console.warn = origWarn;
  }
});

test("onAlert is called once per triggered hit with the hit and context", async () => {
  const seen = [];
  const hitA = { ruleId: "a", kind: "dead-window", triggered: true, severity: "warn", detail: "quiet" };
  const hitB = { ruleId: "b", kind: "activity-surge", triggered: true, severity: "info", detail: "surge" };
  const s = createScheduler({
    watcher: fakeWatcher(() => ({ triggered: [hitA, hitB], window: { since: "s", until: "u" } })),
    intervalMs: 15,
    onAlert: (hit, context) => seen.push({ hit, context })
  });
  s.start();
  await waitFor(() => seen.length >= 2);
  s.stop();
  assert.ok(seen.length >= 2, `expected hits, got ${seen.length}`);
  assert.equal(seen[0].hit, hitA);
  assert.equal(seen[1].hit, hitB);
  assert.equal(seen[0].context.tickCount, 1);
  assert.ok(typeof seen[0].context.at === "string");
  assert.deepEqual(seen[0].context.window, { since: "s", until: "u" });
});

test("a throwing onAlert does not stop delivery of the remaining hits", async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const delivered = [];
  try {
    const s = createScheduler({
      watcher: fakeWatcher(() => ({
        triggered: [
          { ruleId: "bad", kind: "dead-window", triggered: true, severity: "warn", detail: "x" },
          { ruleId: "good", kind: "dead-window", triggered: true, severity: "warn", detail: "y" }
        ],
        window: null
      })),
      intervalMs: 15,
      onAlert: hit => {
        if (hit.ruleId === "bad") throw new Error("delivery boom");
        delivered.push(hit.ruleId);
      }
    });
    s.start();
    await waitFor(() => delivered.includes("good"));
    s.stop();
    assert.ok(delivered.includes("good"), "second hit must still be delivered");
    assert.ok(warnings.some(line => line.includes("alert delivery failed") && line.includes("bad")));
  } finally {
    console.warn = origWarn;
  }
});

test("the timer is unref'd so it never keeps the process alive", () => {
  const s = createScheduler({ watcher: fakeWatcher(), intervalMs: 60000 });
  s.start();
  const timer = s.getTimer();
  assert.ok(timer !== null);
  assert.equal(typeof timer.unref, "function");
  if (typeof timer.hasRef === "function") assert.equal(timer.hasRef(), false);
  s.stop();
});

test("defaultOnAlert logs one structured line with the hit fields", () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    defaultOnAlert(
      { ruleId: "growth:dead-chat", kind: "dead-window", triggered: true, severity: "warn", detail: "no activity\nfor: message.sent" },
      { tickCount: 3, at: "2026-09-16T00:00:00.000Z" }
    );
  } finally {
    console.log = origLog;
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("[growth-alert] warn dead-window growth:dead-chat:"));
  assert.ok(!lines[0].includes("\n"), "must stay one line");
  assert.ok(lines[0].includes("no activity for: message.sent"));
});

test("defaultGrowthRules returns a frozen, usable rule set", () => {
  const rules = defaultGrowthRules();
  assert.ok(Array.isArray(rules) && rules.length === 2);
  assert.ok(Object.isFrozen(rules));
  for (const rule of rules) {
    assert.equal(typeof rule.ruleId, "string");
    assert.equal(typeof rule.kind, "string");
    assert.equal(typeof rule.severity, "string");
  }
});

test("default rules drive a real watcher over a collector", () => {
  const collector = createCollector();
  const msg = (id, occurredAt) =>
    defineEvent("message.sent", { actor: HUMAN, source: "web", fields: { roomId: "r1", messageId: id }, occurredAt });
  const r = collector.record(msg("m1", "2026-09-15T10:05:00Z"));
  assert.equal(r.ok, true);
  const watcher = createWatcher({ collector, rules: defaultGrowthRules(), windowMs: 3600000 });
  const result = watcher.tick("2026-09-15T11:00:00Z");
  assert.ok(Array.isArray(result.hits) && result.hits.length === 2);
  const deadChat = result.hits.find(h => h.ruleId === "growth:dead-chat");
  assert.equal(deadChat.triggered, false, "window had a message — no dead-chat hit");
});

test("DEFAULT_INTERVAL_MS is the documented 5-minute default", () => {
  assert.equal(DEFAULT_INTERVAL_MS, 300000);
});
