// Track C slice C9 — tests for src/growth-alerts.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { summarize } from "../src/growth-summary.js";
import { compareSummaries } from "../src/growth-compare.js";
import {
  activitySurgeRule,
  deadWindowRule,
  mentionSpikeRule,
  engagementDropRule,
  defineRule,
  evaluateAlerts,
  ALERT_KINDS
} from "../src/growth-alerts.js";

const ACTOR = { id: "human-1", kind: "human" };

const ev = (type, fields, occurredAt, actor = ACTOR) =>
  defineEvent(type, { actor, source: "web", fields, occurredAt });

const recordAll = events => {
  const collector = createCollector();
  for (const event of events) {
    const result = collector.record(event);
    assert.equal(result.ok, true, `fixture record failed: ${result.reason}`);
  }
  return collector;
};

// Previous window: quiet — 2 messages, 2 reactions, small mentions.
const previousFixture = () =>
  summarize(recordAll([
    ev("message.sent", { roomId: "r1", messageId: "m1" }, "2026-09-10T10:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m2" }, "2026-09-10T11:00:00Z"),
    ev("reaction.added", { roomId: "r1", messageId: "m1", reaction: "thumbsup" }, "2026-09-10T12:00:00Z"),
    ev("reaction.added", { roomId: "r1", messageId: "m2", reaction: "heart" }, "2026-09-10T13:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m1", mentionedAgentId: "agent-7", mentionCount: 1 }, "2026-09-10T14:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m2", mentionedAgentId: "agent-3", mentionCount: 3 }, "2026-09-10T15:00:00Z")
  ]));

// Current window: 10 messages (4x surge), 1 reaction (-50%), agent-7 spikes to 8.
const currentFixture = () =>
  summarize(recordAll([
    ...Array.from({ length: 10 }, (_, i) =>
      ev("message.sent", { roomId: "r1", messageId: `c${i}` }, `2026-09-11T${String(10 + i).padStart(2, "0")}:00:00Z`)),
    ev("reaction.added", { roomId: "r1", messageId: "c0", reaction: "thumbsup" }, "2026-09-11T21:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "c0", mentionedAgentId: "agent-7", mentionCount: 8 }, "2026-09-11T22:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "c1", mentionedAgentId: "agent-9", mentionCount: 2 }, "2026-09-11T22:30:00Z")
  ]));

const fixtures = () => {
  const current = currentFixture();
  const previous = previousFixture();
  const comparison = compareSummaries(current, previous);
  return { current, previous, comparison };
};

test("activitySurgeRule triggers on a surge and stays quiet below threshold", () => {
  const { current, comparison } = fixtures();
  const surge = activitySurgeRule({ eventType: "message.sent", pctThreshold: 1.0 });
  const quiet = activitySurgeRule({ eventType: "message.sent", pctThreshold: 5.0 });
  const [hitSurge, hitQuiet] = evaluateAlerts([surge, quiet], { summary: current, comparison });
  assert.equal(hitSurge.triggered, true); // 2 -> 10 is +400%
  assert.equal(hitSurge.kind, "activity-surge");
  assert.equal(hitQuiet.triggered, false);
  assert.ok(hitSurge.detail.includes("message.sent"));
});

test("activitySurgeRule treats a move from zero as a surge", () => {
  const empty = summarize(createCollector());
  const { current } = fixtures();
  const comparison = compareSummaries(current, empty);
  const rule = activitySurgeRule({ eventType: "message.sent", pctThreshold: 10 });
  const [hit] = evaluateAlerts([rule], { summary: current, comparison });
  assert.equal(hit.triggered, true);
  assert.ok(hit.detail.includes("rose from 0"));
});

test("deadWindowRule triggers when every listed type is zero", () => {
  const { current } = fixtures();
  const dead = deadWindowRule({ eventTypes: ["room.created", "work.proposed"] });
  const alive = deadWindowRule({ eventTypes: ["message.sent", "room.created"] });
  const [hitDead, hitAlive] = evaluateAlerts([dead, alive], { summary: current });
  assert.equal(hitDead.triggered, true);
  assert.equal(hitDead.severity, "critical");
  assert.equal(hitAlive.triggered, false);
});

test("deadWindowRule with no eventTypes watches every tracked type", () => {
  const { current } = fixtures();
  const rule = deadWindowRule({});
  const [hit] = evaluateAlerts([rule], { summary: current });
  assert.equal(hit.triggered, false); // messages exist, so not dead
  const empty = summarize(createCollector());
  const [hitEmpty] = evaluateAlerts([deadWindowRule({})], { summary: empty });
  assert.equal(hitEmpty.triggered, true);
});

test("mentionSpikeRule triggers for a watched agent at/over threshold", () => {
  const { current } = fixtures();
  const spike = mentionSpikeRule({ agentIds: ["agent-7"], countThreshold: 8 });
  const noSpike = mentionSpikeRule({ agentIds: ["agent-9"], countThreshold: 5 });
  const unknown = mentionSpikeRule({ agentIds: ["agent-ghost"], countThreshold: 1 });
  const [hitSpike, hitNoSpike, hitUnknown] = evaluateAlerts([spike, noSpike, unknown], { summary: current });
  assert.equal(hitSpike.triggered, true); // agent-7 has 8 mentions
  assert.equal(hitSpike.severity, "info");
  assert.equal(hitNoSpike.triggered, false); // agent-9 has 2
  assert.equal(hitUnknown.triggered, false);
});

test("mentionSpikeRule sees agents from the comparison movers too", () => {
  const { current, comparison } = fixtures();
  // agent-3 only appears in the previous window; current mentions are 0.
  const rule = mentionSpikeRule({ agentIds: ["agent-3"], countThreshold: 1 });
  const [hit] = evaluateAlerts([rule], { summary: current, comparison });
  assert.equal(hit.triggered, false);
});

test("engagementDropRule triggers on a qualifying drop", () => {
  const { current, comparison } = fixtures();
  const drop = engagementDropRule({ metric: "reactions", pctThreshold: 0.25 }); // 2 -> 1 is -50%
  const noDrop = engagementDropRule({ metric: "messages", pctThreshold: 0.25 }); // 2 -> 10 is +400%
  const [hitDrop, hitNoDrop] = evaluateAlerts([drop, noDrop], { summary: current, comparison });
  assert.equal(hitDrop.triggered, true);
  assert.equal(hitDrop.severity, "warn");
  assert.equal(hitNoDrop.triggered, false);
});

test("rules needing a comparison report 'needs comparison' when it is null", () => {
  const { current } = fixtures();
  const rules = [
    activitySurgeRule({ eventType: "message.sent", pctThreshold: 1 }),
    engagementDropRule({ metric: "reactions", pctThreshold: 0.25 }),
    deadWindowRule({ eventTypes: ["room.created"] })
  ];
  const [surge, drop, dead] = evaluateAlerts(rules, { summary: current, comparison: null });
  assert.equal(surge.triggered, false);
  assert.equal(surge.detail, "needs comparison");
  assert.equal(drop.triggered, false);
  assert.equal(drop.detail, "needs comparison");
  assert.equal(dead.triggered, true); // dead-window never needs a comparison
});

test("defineRule builds every kind and rejects unknown kinds and bad params", () => {
  const byKind = {
    "activity-surge": { eventType: "message.sent", pctThreshold: 1 },
    "dead-window": { eventTypes: ["room.created"] },
    "mention-spike": { agentIds: ["agent-7"], countThreshold: 3 },
    "engagement-drop": { metric: "reactions", pctThreshold: 0.25 }
  };
  for (const kind of ALERT_KINDS) {
    const rule = defineRule(kind, byKind[kind]);
    assert.equal(rule.kind, kind);
    assert.ok(rule.ruleId.startsWith(`${kind}:`));
    assert.ok(Object.isFrozen(rule));
  }
  assert.throws(() => defineRule("bogus-kind", {}), /unknown rule kind/);
  assert.throws(() => activitySurgeRule({ eventType: "not-a-type", pctThreshold: 1 }), /known growth event type/);
  assert.throws(() => activitySurgeRule({ eventType: "message.sent", pctThreshold: NaN }), /finite/);
  assert.throws(() => deadWindowRule({ eventTypes: [] }), /non-empty array/);
  assert.throws(() => deadWindowRule({ eventTypes: ["nope"] }), /not a known growth event type/);
  assert.throws(() => mentionSpikeRule({ agentIds: ["agent-7"], countThreshold: 0 }), /> 0/);
  assert.throws(() => engagementDropRule({ metric: "bogus", pctThreshold: 0.25 }), /must be one of/);
  assert.throws(() => defineRule("dead-window", null), /params must be an object/);
});

test("evaluateAlerts returns one frozen hit per rule, honoring severity overrides", () => {
  const { current, comparison } = fixtures();
  const rules = [
    defineRule("activity-surge", { eventType: "message.sent", pctThreshold: 1, severity: "critical", ruleId: "surge-msgs" }),
    { ruleId: "plain-dead", kind: "dead-window", severity: "info", params: { eventTypes: ["room.created"] } }
  ];
  const hits = evaluateAlerts(rules, { summary: current, comparison });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.ruleId), ["surge-msgs", "plain-dead"]);
  assert.equal(hits[0].severity, "critical");
  assert.equal(hits[1].severity, "info");
  assert.equal(hits[1].triggered, true);
  for (const hit of hits) {
    assert.deepEqual(Object.keys(hit).sort(), ["detail", "kind", "ruleId", "severity", "triggered"]);
  }
  assert.ok(Object.isFrozen(hits));
  assert.throws(() => { hits.push({}); }, /not extensible/);
});

test("evaluateAlerts is deterministic and fail-closed on malformed inputs", () => {
  const { current, comparison } = fixtures();
  const rules = [activitySurgeRule({ eventType: "message.sent", pctThreshold: 1 })];
  const first = evaluateAlerts(rules, { summary: current, comparison });
  const second = evaluateAlerts(rules, { summary: current, comparison });
  assert.deepEqual(first, second);
  assert.throws(() => evaluateAlerts("nope", { summary: current }), /rules must be an array/);
  assert.throws(() => evaluateAlerts([], {}), /summary must be a summary object/);
  assert.throws(() => evaluateAlerts([{ kind: "bogus" }], { summary: current }), /unknown rule kind/);
  assert.throws(() => evaluateAlerts(rules, { summary: current, comparison: "x" }), /comparison must be/);
});
