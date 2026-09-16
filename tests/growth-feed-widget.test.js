// G002 / C16: activity feed UI widget. Pure string-renderer tests; no DOM needed.
import test from "node:test";
import assert from "node:assert/strict";
import { renderGrowthFeed } from "../src/growth-feed-widget.mjs";

const summary = () => ({ totals: { "message.sent": 42, "reaction.added": 7, "agent.mentioned": 3, "message.pinned": 0 },
  activityByDay: [{ day: "2026-09-14", count: 10 }, { day: "2026-09-15", count: 30 }, { day: "2026-09-16", count: 12 }],
  topMentionedAgents: [{ agentId: "grok", mentions: 5 }, { agentId: "quill", mentions: 2 }],
  engagement: { messages: 42, reactions: 7, pins: 1 },
  window: { since: "2026-09-14T00:00:00Z", until: "2026-09-16T23:59:59Z" }, generatedAt: "2026-09-17T00:00:00Z" });

test("renders a complete feed section", () => {
  const html = renderGrowthFeed(summary());
  assert.ok(html.startsWith('<section class="growth-feed"'));
  assert.ok(html.includes("Room activity"));
  assert.ok(html.includes("2026-09-14 → 2026-09-16"));
  assert.ok(html.includes("message.sent") && html.includes(">42<"));
  assert.ok(html.includes("feed-bar-fill") && html.includes("2026-09-15"));
  assert.ok(html.includes(">grok<") && html.includes(">5<"));
  assert.ok(html.includes("Messages") && html.includes(">1</dd>"));
});
test("empty windows render friendly placeholders", () => {
  const html = renderGrowthFeed({ ...summary(), totals: {}, activityByDay: [], topMentionedAgents: [], engagement: {} });
  assert.ok(html.includes("No activity in this window."));
  assert.ok(html.includes("No events yet."));
  assert.ok(html.includes("No agent mentions in this window."));
});
test("user-derived text is escaped", () => {
  const html = renderGrowthFeed({ ...summary(),
    topMentionedAgents: [{ agentId: '<img src=x onerror=alert(1)>', mentions: 1 }],
    activityByDay: [{ day: '2026-09-16"><script>', count: 1 }] });
  assert.ok(!html.includes("<script>") && !html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});
test("malformed summaries throw, never partial garbage", () => {
  assert.throws(() => renderGrowthFeed(null), /summary must be a summary object/);
  assert.throws(() => renderGrowthFeed({ ...summary(), totals: [] }), /totals must be an object/);
  assert.throws(() => renderGrowthFeed({ ...summary(), activityByDay: {} }), /activityByDay must be an array/);
  assert.throws(() => renderGrowthFeed({ ...summary(), generatedAt: "" }), /generatedAt must be a timestamp/);
  assert.throws(() => renderGrowthFeed({ ...summary(), totals: { "message.sent": Infinity } }), /finite numbers/);
});
test("unbounded windows read as all time", () => {
  const html = renderGrowthFeed({ ...summary(), window: { since: null, until: null } });
  assert.ok(html.includes("all time"));
});
