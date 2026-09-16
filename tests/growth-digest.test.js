// Track C slice C7 — tests for src/growth-digest.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { summarize } from "../src/growth-summary.js";
import { renderDigest, DIGEST_FORMATS, DIGEST_BAR_WIDTH } from "../src/growth-digest.js";

const ACTOR = { id: "human-1", kind: "human" };

const ev = (type, fields, occurredAt, actor = ACTOR) =>
  defineEvent(type, { actor, source: "web", fields, occurredAt });

// Summary with two days where day two has exactly half of day one's count.
const buildSummary = (since, until) => {
  const collector = createCollector();
  const events = [
    ev("message.sent", { roomId: "r1", messageId: "m1" }, "2026-09-10T08:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m2" }, "2026-09-10T09:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m3" }, "2026-09-10T10:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m4" }, "2026-09-10T11:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m1", mentionedAgentId: "agent-9", mentionCount: 2 }, "2026-09-10T12:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m2", mentionedAgentId: "agent-7" }, "2026-09-10T13:00:00Z"),
    ev("reaction.added", { roomId: "r1", messageId: "m1", reaction: "thumbsup" }, "2026-09-10T14:00:00Z"),
    ev("message.pinned", { roomId: "r1", messageId: "m2" }, "2026-09-10T15:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m5" }, "2026-09-11T08:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m6" }, "2026-09-11T09:00:00Z"),
    ev("agent.mentioned", { roomId: "r1", messageId: "m5", mentionedAgentId: "agent-9" }, "2026-09-11T10:00:00Z"),
    ev("message.sent", { roomId: "r1", messageId: "m7" }, "2026-09-11T11:00:00Z")
  ];
  for (const event of events) {
    const result = collector.record(event);
    assert.equal(result.ok, true, `fixture record failed: ${result.reason}`);
  }
  return summarize(collector, { since, until });
};

const barWidthOf = (digest, day) => {
  const line = digest.split("\n").find(l => l.includes(day));
  assert.ok(line, `no line for ${day}`);
  const match = line.match(/(█+)/);
  return match ? match[1].length : 0;
};

test("text digest contains every section", () => {
  const digest = renderDigest(buildSummary());
  assert.ok(digest.includes("Growth digest"));
  assert.ok(digest.includes("Window:"));
  assert.ok(digest.includes("Generated:"));
  assert.ok(digest.includes("Totals:"));
  assert.ok(digest.includes("message.sent: 7"));
  assert.ok(digest.includes("Daily activity:"));
  assert.ok(digest.includes("2026-09-10"));
  assert.ok(digest.includes("2026-09-11"));
  assert.ok(digest.includes("Top mentioned agents:"));
  assert.ok(digest.includes("agent-9"));
  assert.ok(digest.includes("Engagement:"));
  assert.ok(digest.includes("mentions per message:"));
  assert.ok(!digest.startsWith("#"), "text format must not use markdown headers");
});

test("markdown digest uses headers and contains every section", () => {
  const digest = renderDigest(buildSummary(), { format: "markdown" });
  assert.ok(digest.startsWith("# Growth digest"));
  assert.ok(digest.includes("## Totals"));
  assert.ok(digest.includes("## Daily activity"));
  assert.ok(digest.includes("## Top mentioned agents"));
  assert.ok(digest.includes("## Engagement"));
  assert.ok(digest.includes("**Window:**"));
  assert.ok(digest.includes("agent-9"));
  assert.ok(digest.includes("message.sent"));
});

test("daily bars scale proportionally to the max count", () => {
  const summary = buildSummary();
  // Day one: 8 events; day two: 4 events — exactly half.
  const maxBar = barWidthOf(renderDigest(summary), "2026-09-10");
  const halfBar = barWidthOf(renderDigest(summary), "2026-09-11");
  assert.equal(maxBar, DIGEST_BAR_WIDTH);
  assert.ok(Math.abs(halfBar - DIGEST_BAR_WIDTH / 2) <= 1, `half bar ${halfBar} not within ±1 of ${DIGEST_BAR_WIDTH / 2}`);
});

test("engagement renders mentions-per-message as a percent", () => {
  const digest = renderDigest(buildSummary());
  // 4 mentions / 7 messages ≈ 57%.
  assert.ok(digest.includes("mentions per message: 57%"), digest);
});

test("empty summary renders a short no-activity digest, not an empty string", () => {
  const empty = summarize(createCollector());
  for (const format of DIGEST_FORMATS) {
    const digest = renderDigest(empty, { format });
    assert.ok(digest.length > 0, `empty string for ${format}`);
    assert.ok(/no activity/i.test(digest), `no "no activity" line for ${format}: ${digest}`);
  }
  const text = renderDigest(empty);
  assert.ok(text.includes("Growth digest"));
});

test("summary with no messages renders n/a for the ratio", () => {
  const collector = createCollector();
  const event = ev("room.created", { roomId: "r1", roomKind: "personal" }, "2026-09-10T08:00:00Z");
  assert.equal(collector.record(event).ok, true);
  const digest = renderDigest(summarize(collector));
  assert.ok(digest.includes("mentions per message: n/a"), digest);
});

test("window bounds appear in the header", () => {
  const digest = renderDigest(buildSummary("2026-09-10T00:00:00Z", "2026-09-11T23:59:59Z"));
  assert.ok(digest.includes("2026-09-10 → 2026-09-11"), digest);
});

test("zero totals are omitted from the totals section", () => {
  const digest = renderDigest(buildSummary());
  assert.ok(!digest.includes("work.proposed"), digest);
  assert.ok(!digest.includes("inbound.received"), digest);
});

test("invalid inputs throw clear errors", () => {
  assert.throws(() => renderDigest(null), /summary must be a summary object/);
  assert.throws(() => renderDigest("x"), /summary must be a summary object/);
  assert.throws(() => renderDigest([]), /summary must be a summary object/);
  assert.throws(() => renderDigest(buildSummary(), { format: "html" }), /unknown format "html"/);
  assert.throws(() => renderDigest({ ...buildSummary(), totals: null }), /summary\.totals must be an object/);
  assert.throws(() => renderDigest({ ...buildSummary(), engagement: [] }), /summary\.engagement must be an object/);
});

test("rendering is deterministic", () => {
  const summary = buildSummary();
  assert.equal(renderDigest(summary), renderDigest(summary));
  assert.equal(renderDigest(summary, { format: "markdown" }), renderDigest(summary, { format: "markdown" }));
});

test("digest formats are frozen to text and markdown", () => {
  assert.deepEqual([...DIGEST_FORMATS], ["text", "markdown"]);
  assert.equal(DIGEST_BAR_WIDTH, 24);
});
