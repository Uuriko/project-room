// Track C slice C5 — tests for src/growth-summary.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { summarize, DEFAULT_TOP_MENTIONED_AGENTS } from "../src/growth-summary.js";

const ACTOR = { id: "human-1", kind: "human" };

const ev = (type, fields, occurredAt, actor = ACTOR) =>
  defineEvent(type, { actor, source: "web", fields, occurredAt });

// A collector with events spread across three UTC days, including a
// day-boundary pair (23:59:59Z vs 00:00:00Z).
const buildFixture = () => {
  const collector = createCollector();
  const events = [
    ev("room.created", { roomId: "r1", roomKind: "personal" }, "2026-09-10T08:00:00Z"),
    ev("member.joined", { roomId: "r1", memberId: "human-1", memberKind: "human", via: "direct" }, "2026-09-10T09:00:00Z"),
    ev("member.joined", { roomId: "r1", memberId: "agent-9", memberKind: "agent", via: "invitation" }, "2026-09-10T10:00:00Z", { id: "agent-9", kind: "agent" }),
    ev("message.sent", { roomId: "r1", messageId: "m1", lengthBucket: "short" }, "2026-09-10T23:59:59Z"),
    ev("message.sent", { roomId: "r1", messageId: "m2", lengthBucket: "long" }, "2026-09-11T00:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m3" }, "2026-09-11T12:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m2", mentionedAgentId: "agent-9", mentionCount: 2 }, "2026-09-11T00:00:01Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m3", mentionedAgentId: "agent-7" }, "2026-09-11T12:00:01Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m3", mentionedAgentId: "agent-9" }, "2026-09-11T12:00:02Z"),
    ev("reaction.added", { roomId: "r1", messageId: "m1", reaction: "thumbsup" }, "2026-09-11T13:00:00Z"),
    ev("reaction.added", { roomId: "r1", messageId: "m2", reaction: "heart" }, "2026-09-12T13:00:00Z"),
    ev("message.pinned", { roomId: "r1", messageId: "m2" }, "2026-09-12T14:00:00Z"),
    ev("work.proposed", { roomId: "r1", workItemId: "w1" }, "2026-09-12T15:00:00Z"),
    ev("work.completed", { roomId: "r1", workItemId: "w1", verificationKind: "none" }, "2026-09-12T16:00:00Z"),
    ev("help.offer_opened", { roomId: "r1", offerId: "o1" }, "2026-09-12T17:00:00Z"),
    ev("invite.accepted", { roomId: "r1", invitationId: "i1", via: "link" }, "2026-09-12T18:00:00Z"),
    ev("notification.preference_set", { roomId: "r1", channel: "mentions", level: "all" }, "2026-09-12T19:00:00Z"),
    ev("inbound.received", { channel: "email", roomId: "r1", hasAttachment: false }, "2026-09-12T20:00:00Z")
  ];
  for (const event of events) {
    const result = collector.record(event);
    assert.equal(result.ok, true, `fixture record failed: ${result.reason}`);
  }
  return collector;
};

test("totals count every growth event type in the window", () => {
  const summary = summarize(buildFixture());
  assert.equal(summary.totals["room.created"], 1);
  assert.equal(summary.totals["member.joined"], 2);
  assert.equal(summary.totals["message.sent"], 3);
  assert.equal(summary.totals["agent.mentioned"], 3);
  assert.equal(summary.totals["reaction.added"], 2);
  assert.equal(summary.totals["message.pinned"], 1);
  assert.equal(summary.totals["work.proposed"], 1);
  assert.equal(summary.totals["work.completed"], 1);
  assert.equal(summary.totals["help.offer_opened"], 1);
  assert.equal(summary.totals["invite.accepted"], 1);
  assert.equal(summary.totals["notification.preference_set"], 1);
  assert.equal(summary.totals["inbound.received"], 1);
});

test("window bounds restrict the summarized events", () => {
  const collector = buildFixture();
  const day11 = summarize(collector, { since: "2026-09-11T00:00:00Z", until: "2026-09-11T23:59:59Z" });
  assert.equal(day11.totals["message.sent"], 2);
  assert.equal(day11.totals["room.created"], 0);
  assert.equal(day11.window.since, "2026-09-11T00:00:00.000Z");
  assert.equal(day11.window.until, "2026-09-11T23:59:59.000Z");
  const open = summarize(collector);
  assert.equal(open.window.since, null);
  assert.equal(open.window.until, null);
});

test("activityByDay buckets on UTC days and sorts ascending, including day-boundary events", () => {
  const summary = summarize(buildFixture());
  assert.deepEqual(summary.activityByDay, [
    { day: "2026-09-10", count: 4 },
    { day: "2026-09-11", count: 6 },
    { day: "2026-09-12", count: 8 }
  ]);
});

test("topMentionedAgents aggregates mention counts and orders descending", () => {
  const summary = summarize(buildFixture());
  assert.deepEqual(summary.topMentionedAgents, [
    { agentId: "agent-9", mentions: 3 },
    { agentId: "agent-7", mentions: 1 }
  ]);
});

test("topN caps the mentioned-agent list", () => {
  const summary = summarize(buildFixture(), { topN: 1 });
  assert.equal(summary.topMentionedAgents.length, 1);
  assert.equal(summary.topMentionedAgents[0].agentId, "agent-9");
  assert.equal(DEFAULT_TOP_MENTIONED_AGENTS, 10);
});

test("engagement counts messages, reactions, pins, mentions and the mentions-per-message ratio", () => {
  const summary = summarize(buildFixture());
  assert.deepEqual(summary.engagement, {
    messages: 3,
    reactions: 2,
    pins: 1,
    mentions: 4,
    mentionsPerMessage: 4 / 3
  });
});

test("empty collector yields a zeroed summary, not null", () => {
  const summary = summarize(createCollector());
  assert.equal(Object.values(summary.totals).every(n => n === 0), true);
  assert.deepEqual(summary.activityByDay, []);
  assert.deepEqual(summary.topMentionedAgents, []);
  assert.deepEqual(summary.engagement, {
    messages: 0,
    reactions: 0,
    pins: 0,
    mentions: 0,
    mentionsPerMessage: null
  });
  assert.match(summary.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("bad window bounds throw a clear error", () => {
  const collector = buildFixture();
  assert.throws(() => summarize(collector, { since: "not-a-date" }), /"since" must be an ISO-8601 timestamp/);
  assert.throws(() => summarize(collector, { until: "" }), /"until" must be an ISO-8601 timestamp/);
  assert.throws(
    () => summarize(collector, { since: "2026-09-12T00:00:00Z", until: "2026-09-11T00:00:00Z" }),
    /"since" must not be after "until"/
  );
  assert.throws(() => summarize(null), /collector must be a collector object/);
  assert.throws(() => summarize({}), /must expose query\(\) and stats\(\)/);
  assert.throws(() => summarize(collector, { topN: 0 }), /topN must be a positive integer/);
});

test("summary output is frozen", () => {
  const summary = summarize(buildFixture());
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.totals), true);
  assert.equal(Object.isFrozen(summary.activityByDay), true);
  assert.equal(Object.isFrozen(summary.activityByDay[0]), true);
  assert.equal(Object.isFrozen(summary.topMentionedAgents), true);
  assert.equal(Object.isFrozen(summary.engagement), true);
  assert.equal(Object.isFrozen(summary.window), true);
});

test("window with no events in range yields zeros", () => {
  const summary = summarize(buildFixture(), { since: "2027-01-01T00:00:00Z", until: "2027-12-31T23:59:59Z" });
  assert.equal(Object.values(summary.totals).every(n => n === 0), true);
  assert.deepEqual(summary.activityByDay, []);
  assert.equal(summary.engagement.mentionsPerMessage, null);
});
