import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  classifySource, currentRequestContext, normalizeAgentClient, runWithRequestContext, writeAnalyticsContext
} from "../server/analytics/context.mjs";

test("source classification uses the first matching ingress rule", () => {
  assert.equal(classifySource({ url: "/mcp", headers: { cookie: "room_session=abc" } }), "mcp");
  assert.equal(classifySource({ url: "/room/mcp/cursor" }), "mcp");
  assert.equal(classifySource({ url: "/api/inbound/email" }), "webhook");
  assert.equal(classifySource({ url: "/api/webhooks/github" }), "webhook");
  assert.equal(classifySource({ url: "/api/rooms" }, { email: true }), "webhook");
  assert.equal(classifySource({ url: "/api/rooms" }, { cron: true }), "cron");
  assert.equal(classifySource({ url: "/api/rooms", headers: { cookie: "account_session=abc" } }), "ui");
  assert.equal(classifySource({ url: "/api/rooms" }, { cookie: true }), "ui");
  assert.equal(classifySource({ url: "/api/rooms", headers: { authorization: "Bearer tok" } }), "rest");
  assert.equal(classifySource({ url: "/api/rooms" }, { bearer: true }), "rest");
  assert.equal(classifySource({ url: "/api/rooms" }), "unknown");
  assert.equal(normalizeAgentClient("Cursor Composer"), "cursor");
  assert.equal(normalizeAgentClient("Claude Desktop"), "claude-code");
  assert.equal(normalizeAgentClient("Codex CLI"), "codex");
  assert.equal(normalizeAgentClient("Devin"), "devin");
  assert.equal(normalizeAgentClient("custom-host"), "other");
  assert.equal(normalizeAgentClient(""), null);
});

test("request context is scoped, and the context spill stays inside its cap", async () => {
  assert.equal(currentRequestContext(), null);
  const seen = await runWithRequestContext({ source: "ui" }, async () => {
    assert.deepEqual(currentRequestContext(), { source: "ui" });
    return currentRequestContext().source;
  });
  assert.equal(seen, "ui");
  assert.equal(currentRequestContext(), null);

  const db = new DatabaseSync(":memory:");
  const base = Date.parse("2026-09-30T15:00:00.000Z");
  for (let i = 0; i < 5; i += 1) writeAnalyticsContext(db, { eventId: `e${i}`, source: "ui", at: base + i, maxRows: 3 });
  const kept = db.prepare("SELECT event_id FROM analytics_ctx ORDER BY at").all().map(row => row.event_id);
  assert.deepEqual(kept, ["e2", "e3", "e4"]);
  writeAnalyticsContext(db, { eventId: "fresh", source: "mcp", at: base + 10, maxRows: 3, maxAgeMs: 5 });
  const aged = db.prepare("SELECT event_id FROM analytics_ctx ORDER BY event_id").all().map(row => row.event_id);
  assert.deepEqual(aged, ["fresh"]);
  db.close();
});
