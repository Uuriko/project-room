// Track C slice C12 — tests for src/growth-watch.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { createFanout } from "../src/growth-fanout.js";
import { createWatcher, DEFAULT_WINDOW_MS } from "../src/growth-watch.js";
import {
  activitySurgeRule,
  deadWindowRule,
  mentionSpikeRule
} from "../src/growth-alerts.js";

const HUMAN = { id: "human-1", kind: "human" };

const ev = (type, fields, occurredAt) =>
  defineEvent(type, { actor: HUMAN, source: "web", fields, occurredAt });

const msg = (id, occurredAt) =>
  ev("message.sent", { roomId: "r1", messageId: id }, occurredAt);

const mention = (agentId, count, occurredAt) =>
  ev("agent.mentioned", { roomId: "r1", messageId: "m-x", mentionedAgentId: agentId, mentionCount: count }, occurredAt);

// Events across two adjacent one-hour windows on 2026-09-15 (UTC):
// W1 [10:00, 11:00): 2 messages, agent-7 mentioned once.
// W2 [11:00, 12:00): 6 messages, agent-7 mentioned 3 times.
const buildFixture = () => {
  const collector = createCollector();
  const events = [
    msg("m1", "2026-09-15T10:05:00Z"),
    msg("m2", "2026-09-15T10:35:00Z"),
    mention("agent-7", 1, "2026-09-15T10:40:00Z"),
    msg("m3", "2026-09-15T11:05:00Z"),
    msg("m4", "2026-09-15T11:10:00Z"),
    msg("m5", "2026-09-15T11:20:00Z"),
    msg("m6", "2026-09-15T11:30:00Z"),
    msg("m7", "2026-09-15T11:40:00Z"),
    msg("m8", "2026-09-15T11:50:00Z"),
    mention("agent-7", 3, "2026-09-15T11:25:00Z")
  ];
  for (const event of events) {
    const result = collector.record(event);
    assert.equal(result.ok, true, `fixture record failed: ${result.reason}`);
  }
  return collector;
};

const rules = () => [
  activitySurgeRule({ eventType: "message.sent", pctThreshold: 1.0, ruleId: "surge" }),
  mentionSpikeRule({ agentIds: ["agent-7"], countThreshold: 3, ruleId: "spike" })
];

const HOUR = 3600000;

test("first tick has no comparison; comparison-needing rules report needs-comparison", () => {
  const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR });
  assert.equal(watcher.getLastRun(), null);
  assert.equal(watcher.getPreviousSummary(), null);

  const result = watcher.tick(new Date("2026-09-15T11:00:00Z"));
  assert.equal(result.comparison, null);
  assert.equal(result.window.since, "2026-09-15T10:00:00.000Z");
  assert.equal(result.window.until, "2026-09-15T11:00:00.000Z");
  assert.equal(result.summary.totals["message.sent"], 2);

  const surge = result.hits.find(h => h.ruleId === "surge");
  assert.equal(surge.triggered, false);
  assert.equal(surge.detail, "needs comparison");

  const spike = result.hits.find(h => h.ruleId === "spike");
  assert.equal(spike.triggered, false); // 1 mention < threshold 3

  assert.equal(result.triggered.length, 0);
  assert.equal(result.published, 0);
  assert.equal(watcher.getLastRun(), "2026-09-15T11:00:00.000Z");
  assert.equal(watcher.getPreviousSummary().totals["message.sent"], 2);
});

test("second tick compares windows and fires surge + spike rules", () => {
  const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR });
  watcher.tick(new Date("2026-09-15T11:00:00Z"));
  const result = watcher.tick(new Date("2026-09-15T12:00:00Z"));

  assert.equal(result.summary.totals["message.sent"], 6);
  assert.notEqual(result.comparison, null);
  // 2 -> 6 messages = +200%, threshold +100%
  const surge = result.hits.find(h => h.ruleId === "surge");
  assert.equal(surge.triggered, true);
  // agent-7: 3 mentions in the window, threshold 3
  const spike = result.hits.find(h => h.ruleId === "spike");
  assert.equal(spike.triggered, true);
  assert.equal(result.triggered.length, 2);
  assert.deepEqual(result.triggered.map(h => h.ruleId).sort(), ["spike", "surge"]);
});

test("tick is safe to repeat and accessors track the latest run", () => {
  const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR });
  watcher.tick(new Date("2026-09-15T11:00:00Z"));
  watcher.tick(new Date("2026-09-15T12:00:00Z"));
  const again = watcher.tick(new Date("2026-09-15T12:00:00Z"));
  // Same window re-ticked: comparison is current vs itself -> flat, no surge.
  const surge = again.hits.find(h => h.ruleId === "surge");
  assert.equal(surge.triggered, false);
  assert.equal(watcher.getLastRun(), "2026-09-15T12:00:00.000Z");
  assert.equal(watcher.getPreviousSummary().totals["message.sent"], 6);
});

test("setRules swaps the rule set; comparison survives the swap", () => {
  const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR });
  watcher.tick(new Date("2026-09-15T11:00:00Z"));
  watcher.setRules([deadWindowRule({ eventTypes: ["message.sent"], ruleId: "dead" })]);
  // Window [12:00, 13:00) has no events -> dead window triggers.
  const result = watcher.tick(new Date("2026-09-15T13:00:00Z"));
  assert.equal(result.summary.totals["message.sent"], 0);
  assert.notEqual(result.comparison, null); // previous summary kept across setRules
  const dead = result.hits.find(h => h.ruleId === "dead");
  assert.equal(dead.triggered, true);
  assert.equal(result.hits.length, 1);
  assert.throws(() => watcher.setRules("nope"), /rules must be an array/);
});

test("fanout is accepted but alert hits are not published (no C1 envelope exists)", () => {
  const fanout = createFanout();
  let received = 0;
  fanout.subscribe(() => true, () => { received += 1; });
  const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR, fanout });
  watcher.tick(new Date("2026-09-15T11:00:00Z"));
  const result = watcher.tick(new Date("2026-09-15T12:00:00Z"));
  assert.equal(result.triggered.length, 2);
  assert.equal(result.published, 0);
  assert.equal(received, 0);
  assert.equal(fanout.getHandlerFailures(), 0);
});

test("tick results are frozen", () => {
  const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR });
  watcher.tick(new Date("2026-09-15T11:00:00Z"));
  const result = watcher.tick(new Date("2026-09-15T12:00:00Z"));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.hits));
  assert.ok(Object.isFrozen(result.triggered));
  assert.ok(Object.isFrozen(result.summary));
  assert.ok(Object.isFrozen(result.comparison));
  assert.throws(() => { result.hits.push({}); }, TypeError);
  assert.throws(() => { result.triggered.length = 0; }, TypeError);
});

test("evaluation is deterministic given the same events and tick times", () => {
  const run = () => {
    const watcher = createWatcher({ collector: buildFixture(), rules: rules(), windowMs: HOUR });
    watcher.tick(new Date("2026-09-15T11:00:00Z"));
    return watcher.tick(new Date("2026-09-15T12:00:00Z"));
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.triggered, b.triggered);
  assert.deepEqual(a.hits, b.hits);
  assert.deepEqual(a.window, b.window);
});

test("tick accepts an ISO string and defaults to now", () => {
  const watcher = createWatcher({ collector: buildFixture(), rules: [], windowMs: HOUR });
  const result = watcher.tick("2026-09-15T12:00:00Z");
  assert.equal(result.window.until, "2026-09-15T12:00:00.000Z");
  const nowish = watcher.tick();
  assert.ok(typeof nowish.window.until === "string");
  assert.ok(!Number.isNaN(Date.parse(nowish.window.until)));
});

test("createWatcher and tick fail closed on bad inputs", () => {
  const collector = buildFixture();
  assert.throws(() => createWatcher(), /collector must be a collector object/);
  assert.throws(() => createWatcher({ collector, rules: "nope" }), /rules must be an array/);
  assert.throws(() => createWatcher({ collector, rules: [], windowMs: 0 }), /windowMs must be a positive/);
  assert.throws(() => createWatcher({ collector, rules: [], windowMs: -5 }), /windowMs must be a positive/);
  assert.throws(() => createWatcher({ collector, rules: [], fanout: 42 }), /fanout must be a fan-out hub/);
  assert.throws(() => createWatcher({ rules: [] }), /collector must be a collector object/);
  const watcher = createWatcher({ collector, rules: [], windowMs: HOUR });
  assert.throws(() => watcher.tick("not-a-date"), /tick now must be/);
});

test("default window is one hour", () => {
  assert.equal(DEFAULT_WINDOW_MS, 3600000);
  const watcher = createWatcher({ collector: buildFixture(), rules: [] });
  const before = Date.now();
  const result = watcher.tick();
  const after = Date.now();
  const span = Date.parse(result.window.until) - Date.parse(result.window.since);
  assert.equal(span, 3600000);
  assert.ok(Date.parse(result.window.until) >= before && Date.parse(result.window.until) <= after);
});
