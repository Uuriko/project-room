// Track C slice C8 — tests for src/growth-compare.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { summarize } from "../src/growth-summary.js";
import { compareSummaries } from "../src/growth-compare.js";

const ACTOR = { id: "human-1", kind: "human" };

const ev = (type, fields, occurredAt, actor = ACTOR) =>
  defineEvent(type, { actor, source: "web", fields, occurredAt });

const buildCollector = events => {
  const collector = createCollector();
  for (const event of events) {
    const result = collector.record(event);
    assert.equal(result.ok, true, `fixture record failed: ${result.reason}`);
  }
  return collector;
};

// Previous window: 4 messages, 2 reactions, mentions to agent-9 (3) and
// agent-3 (2, dropped in current), no work events.
const previousSummary = () =>
  summarize(
    buildCollector([
      ev("message.sent", { roomId: "r1", messageId: "m1" }, "2026-09-01T08:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "m2" }, "2026-09-01T09:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "m3" }, "2026-09-01T10:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "m4" }, "2026-09-01T11:00:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "m1", mentionedAgentId: "agent-9", mentionCount: 2 }, "2026-09-01T08:01:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "m2", mentionedAgentId: "agent-9" }, "2026-09-01T09:01:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "m3", mentionedAgentId: "agent-3" }, "2026-09-01T10:01:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "m4", mentionedAgentId: "agent-3" }, "2026-09-01T11:01:00Z"),
      ev("reaction.added", { roomId: "r1", messageId: "m1", reaction: "thumbsup" }, "2026-09-01T12:00:00Z"),
      ev("reaction.added", { roomId: "r1", messageId: "m2", reaction: "heart" }, "2026-09-01T13:00:00Z")
    ]),
    { since: "2026-09-01T00:00:00Z", until: "2026-09-01T23:59:59Z" }
  );

// Current window: 6 messages (+50%), 0 reactions (-100%), mentions shift to
// agent-9 (1) and a newcomer agent-7 (4), plus a from-zero type.
const currentSummary = () =>
  summarize(
    buildCollector([
      ev("message.sent", { roomId: "r1", messageId: "n1" }, "2026-09-08T08:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "n2" }, "2026-09-08T09:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "n3" }, "2026-09-08T10:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "n4" }, "2026-09-08T11:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "n5" }, "2026-09-08T12:00:00Z"),
      ev("message.sent", { roomId: "r1", messageId: "n6" }, "2026-09-08T13:00:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "n1", mentionedAgentId: "agent-9" }, "2026-09-08T08:01:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "n2", mentionedAgentId: "agent-7", mentionCount: 2 }, "2026-09-08T09:01:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "n3", mentionedAgentId: "agent-7" }, "2026-09-08T10:01:00Z"),
      ev("agent.mentioned", { roomId: "r1", messageId: "n4", mentionedAgentId: "agent-7" }, "2026-09-08T11:01:00Z"),
      ev("work.completed", { roomId: "r1", workItemId: "w1", verificationKind: "none" }, "2026-09-08T14:00:00Z")
    ]),
    { since: "2026-09-08T00:00:00Z", until: "2026-09-08T23:59:59Z" }
  );

const perType = (comparison, type) =>
  comparison.perType.find(entry => entry.type === type);

const walkNumbers = value => {
  if (typeof value === "number") {
    assert.ok(!Number.isNaN(value), "NaN found in comparison output");
    assert.ok(Number.isFinite(value), "Infinity found in comparison output");
  } else if (Array.isArray(value)) {
    value.forEach(walkNumbers);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(walkNumbers);
  }
};

test("per-type deltas, percent changes and directions", () => {
  const comparison = compareSummaries(currentSummary(), previousSummary());
  const messages = perType(comparison, "message.sent");
  assert.equal(messages.current, 6);
  assert.equal(messages.previous, 4);
  assert.equal(messages.delta, 2);
  assert.equal(messages.pctChange, 0.5);
  assert.equal(messages.direction, "up");
  assert.equal(messages.fromZero, false);

  const reactions = perType(comparison, "reaction.added");
  assert.equal(reactions.delta, -2);
  assert.equal(reactions.pctChange, -1);
  assert.equal(reactions.direction, "down");

  const pins = perType(comparison, "message.pinned");
  assert.equal(pins.delta, 0);
  assert.equal(pins.pctChange, 0);
  assert.equal(pins.direction, "flat");
  assert.equal(pins.fromZero, false);
});

test("a type present only in the current window is marked fromZero", () => {
  const comparison = compareSummaries(currentSummary(), previousSummary());
  const completed = perType(comparison, "work.completed");
  assert.equal(completed.current, 1);
  assert.equal(completed.previous, 0);
  assert.equal(completed.delta, 1);
  assert.equal(completed.pctChange, null);
  assert.equal(completed.fromZero, true);
  assert.equal(completed.direction, "up");
});

test("engagement shifts mirror per-type deltas", () => {
  const comparison = compareSummaries(currentSummary(), previousSummary());
  assert.equal(comparison.engagementShift.messages.delta, 2);
  assert.equal(comparison.engagementShift.reactions.delta, -2);
  assert.equal(comparison.engagementShift.pins.delta, 0);
  assert.equal(comparison.engagementShift.mentions.delta, 0);
  assert.equal(comparison.engagementShift.mentions.direction, "flat");
  // mentionsPerMessage: 5/4 -> 5/6
  assert.equal(comparison.engagementShift.mentionsPerMessage.current, 5 / 6);
  assert.equal(comparison.engagementShift.mentionsPerMessage.previous, 5 / 4);
  assert.equal(comparison.engagementShift.mentionsPerMessage.direction, "down");
  assert.ok(Math.abs(comparison.engagementShift.mentionsPerMessage.pctChange - ((5 / 6 - 5 / 4) / (5 / 4))) < 1e-12);
});

test("a previous window with no messages yields a null ratio, handled without NaN", () => {
  const empty = summarize(buildCollector([]));
  const current = currentSummary();
  const comparison = compareSummaries(current, empty);
  assert.equal(comparison.engagementShift.mentionsPerMessage.previous, null);
  assert.equal(comparison.engagementShift.mentionsPerMessage.current, 5 / 6);
  assert.equal(comparison.engagementShift.mentionsPerMessage.pctChange, null);
  assert.equal(comparison.engagementShift.mentionsPerMessage.fromZero, true);
  assert.equal(comparison.engagementShift.mentionsPerMessage.direction, "up");
  // both windows empty: ratio flat, not NaN
  const bothEmpty = compareSummaries(empty, empty);
  assert.equal(bothEmpty.engagementShift.mentionsPerMessage.pctChange, null);
  assert.equal(bothEmpty.engagementShift.mentionsPerMessage.direction, "flat");
  walkNumbers(comparison);
  walkNumbers(bothEmpty);
});

test("topMentionedMovers orders by delta with new and dropped agents", () => {
  const comparison = compareSummaries(currentSummary(), previousSummary());
  const movers = comparison.topMentionedMovers;
  assert.equal(movers[0].agentId, "agent-7");
  assert.deepEqual([movers[0].currentMentions, movers[0].previousMentions, movers[0].delta], [4, 0, 4]);
  const dropped = movers.find(entry => entry.agentId === "agent-3");
  assert.deepEqual([dropped.currentMentions, dropped.previousMentions, dropped.delta], [0, 2, -2]);
  const falling = movers.find(entry => entry.agentId === "agent-9");
  assert.deepEqual([falling.currentMentions, falling.previousMentions, falling.delta], [1, 3, -2]);
  assert.equal(movers[1].agentId, "agent-3"); // ties break by agentId ascending
  assert.equal(movers[2].agentId, "agent-9");
});

test("windows are echoed through and the output is frozen", () => {
  const current = currentSummary();
  const previous = previousSummary();
  const comparison = compareSummaries(current, previous);
  assert.deepEqual(comparison.windows.current, current.window);
  assert.deepEqual(comparison.windows.previous, previous.window);
  assert.ok(Object.isFrozen(comparison));
  assert.ok(Object.isFrozen(comparison.perType));
  assert.ok(Object.isFrozen(comparison.engagementShift));
  assert.ok(Object.isFrozen(comparison.topMentionedMovers));
  assert.ok(Object.isFrozen(comparison.windows));
});

test("invalid inputs throw clear errors", () => {
  const good = currentSummary();
  assert.throws(() => compareSummaries(null, good), /"current"/);
  assert.throws(() => compareSummaries(good, undefined), /"previous"/);
  assert.throws(() => compareSummaries([], good), /"current"/);
  assert.throws(() => compareSummaries({ ...good, totals: null }, good), /totals/);
  assert.throws(() => compareSummaries({ ...good, engagement: "x" }, good), /engagement/);
  assert.throws(() => compareSummaries({ ...good, topMentionedAgents: {} }, good), /topMentionedAgents/);
  assert.throws(() => compareSummaries({ ...good, window: [] }, good), /window/);
  assert.throws(() => compareSummaries({ ...good, totals: { "message.sent": "six" } }, good), /totals/);
});

test("comparison is deterministic for identical inputs", () => {
  const first = compareSummaries(currentSummary(), previousSummary());
  const second = compareSummaries(currentSummary(), previousSummary());
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});
