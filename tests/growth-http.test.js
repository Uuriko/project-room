// Track C slice C14 — tests for src/growth-http.js.
//
// Covers the read-only growth HTTP surface: route behavior for
// /growth/summary, /growth/digest and /growth/health, the read-only
// guarantee (collector state snapshotted before/after every GET and asserted
// unchanged), 404 on unknown growth subpaths, 405 on non-GET, 400 on
// unknown digest formats, and the no-handle-leak guarantee on /growth/health.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineEvent } from "../src/growth-events.js";
import { createCollector } from "../src/growth-collector.js";
import { createGrowthHttp, GROWTH_ROUTES } from "../src/growth-http.js";

const HUMAN = { id: "human-1", kind: "human" };

const messageEvent = (messageId, occurredAt) =>
  defineEvent("message.sent", {
    actor: HUMAN,
    source: "web",
    fields: { roomId: "room-1", messageId },
    occurredAt
  });

const mentionEvent = (messageId, mentionedAgentId, occurredAt) =>
  defineEvent("agent.mentioned", {
    actor: HUMAN,
    source: "web",
    fields: { roomId: "room-1", messageId, mentionedAgentId },
    occurredAt
  });

// A collector with a few real events so summaries/digests are non-trivial.
const seededCollector = () => {
  const collector = createCollector({ maxEvents: 100 });
  assert.equal(collector.record(messageEvent("m-1", "2026-09-10T10:00:00.000Z")).ok, true);
  assert.equal(collector.record(messageEvent("m-2", "2026-09-11T10:00:00.000Z")).ok, true);
  assert.equal(collector.record(mentionEvent("m-3", "agent-x", "2026-09-11T11:00:00.000Z")).ok, true);
  return collector;
};

const schedulerGetter = ({ running = true, tickCount = 7, intervalMs = 300000 } = {}) =>
  () => ({ running, tickCount, intervalMs });

// Deep snapshot of everything observable about the collector: stats plus
// every stored envelope id in order. Compared before/after GETs.
const collectorSnapshot = collector =>
  JSON.stringify({
    stats: collector.stats(),
    ids: collector.query({ limit: collector.stats().capacity }).map(envelope =>
      `${envelope.type}:${envelope.fields.messageId}`)
  });

// Assert a value tree contains no functions (no leaked handles) and is
// JSON-round-trippable — the module-level half of the JSON content-type
// contract (the wire half is the shared json() helper in server/http.mjs).
const assertJsonSafe = (value, seen = new Set()) => {
  if (typeof value === "function") assert.fail("response leaks a function value");
  if (value !== null && typeof value === "object") {
    assert.ok(!seen.has(value), "response contains a cycle");
    seen.add(value);
    Object.values(value).forEach(child => assertJsonSafe(child, seen));
  }
  assert.doesNotThrow(() => JSON.stringify(value), "response must be JSON-serializable");
};

const get = (http, path, searchParams) => http.handle(path, "GET", searchParams);

test("constructor validates its inputs", () => {
  assert.throws(() => createGrowthHttp(), /collector/);
  assert.throws(() => createGrowthHttp({ collector: {} }), /collector/);
  assert.throws(() => createGrowthHttp({ collector: createCollector(), getSchedulerStatus: 42 }), /getSchedulerStatus/);
});

test("handle returns null for non-growth paths so callers can fall through", () => {
  const http = createGrowthHttp({ collector: createCollector() });
  assert.equal(http.handle("/api/health", "GET"), null);
  assert.equal(http.handle("/", "GET"), null);
  assert.equal(http.handle("/growth", "GET"), null);
  assert.equal(http.handle(null, "GET"), null);
});

test("GROWTH_ROUTES lists the three served routes", () => {
  assert.deepEqual([...GROWTH_ROUTES].sort(), ["/growth/digest", "/growth/health", "/growth/summary"]);
});

test("/growth/summary returns a C5 summary snapshot", () => {
  const http = createGrowthHttp({ collector: seededCollector(), getSchedulerStatus: schedulerGetter() });
  const reply = get(http, "/growth/summary");
  assert.equal(reply.status, 200);
  assertJsonSafe(reply.body);
  assert.equal(reply.body.totals["message.sent"], 2);
  assert.equal(reply.body.totals["agent.mentioned"], 1);
  assert.ok(Array.isArray(reply.body.activityByDay));
  assert.equal(reply.body.topMentionedAgents[0].agentId, "agent-x");
  assert.ok(reply.body.engagement);
  assert.ok(reply.body.window);
  assert.ok(typeof reply.body.generatedAt === "string");
});

test("/growth/digest renders text by default and markdown on request", () => {
  const http = createGrowthHttp({ collector: seededCollector(), getSchedulerStatus: schedulerGetter() });
  const text = get(http, "/growth/digest", new URLSearchParams());
  assert.equal(text.status, 200);
  assertJsonSafe(text.body);
  assert.equal(text.body.format, "text");
  assert.match(text.body.digest, /Growth digest/);
  assert.match(text.body.digest, /message\.sent: 2/);

  const markdown = get(http, "/growth/digest", new URLSearchParams({ format: "markdown" }));
  assert.equal(markdown.status, 200);
  assert.equal(markdown.body.format, "markdown");
  assert.match(markdown.body.digest, /^# Growth digest/m);
});

test("/growth/digest rejects unknown formats with a 400", () => {
  const http = createGrowthHttp({ collector: seededCollector() });
  const reply = get(http, "/growth/digest", new URLSearchParams({ format: "yaml" }));
  assert.equal(reply.status, 400);
  assert.equal(reply.body.error, "unsupported_format");
  assert.ok(reply.body.supported.includes("text"));
});

test("/growth/health reports scheduler status and collector size without leaking handles", () => {
  const http = createGrowthHttp({ collector: seededCollector(), getSchedulerStatus: schedulerGetter({ running: true, tickCount: 7, intervalMs: 300000 }) });
  const reply = get(http, "/growth/health");
  assert.equal(reply.status, 200);
  assertJsonSafe(reply.body);
  assert.equal(reply.body.status, "ok");
  assert.deepEqual(reply.body.scheduler, { running: true, tickCount: 7, intervalMs: 300000 });
  assert.deepEqual(reply.body.collector, { total: 3, recorded: 3, dropped: 0 });
});

test("/growth/health degrades gracefully without a scheduler getter", () => {
  const http = createGrowthHttp({ collector: createCollector() });
  const reply = get(http, "/growth/health");
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.scheduler, { running: false, tickCount: 0, intervalMs: 0 });
});

test("/growth/health survives a throwing scheduler getter", () => {
  const http = createGrowthHttp({
    collector: createCollector(),
    getSchedulerStatus: () => { throw new Error("boom"); }
  });
  const reply = get(http, "/growth/health");
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.scheduler, { running: false, tickCount: 0, intervalMs: 0 });
});

test("unknown growth subpaths are an explicit 404", () => {
  const http = createGrowthHttp({ collector: createCollector() });
  for (const path of ["/growth/nope", "/growth/summary/extra", "/growth/"]) {
    const reply = get(http, path);
    assert.equal(reply.status, 404, path);
    assert.equal(reply.body.error, "not_found");
  }
});

test("non-GET methods on known routes are a 405", () => {
  const http = createGrowthHttp({ collector: createCollector() });
  for (const path of GROWTH_ROUTES) {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const reply = http.handle(path, method);
      assert.equal(reply.status, 405, `${method} ${path}`);
      assert.equal(reply.body.error, "method_not_allowed");
    }
  }
});

test("GETs are side-effect-free: collector state is identical before and after", () => {
  const collector = seededCollector();
  let schedulerCalls = 0;
  const http = createGrowthHttp({
    collector,
    getSchedulerStatus: () => { schedulerCalls += 1; return { running: true, tickCount: 7, intervalMs: 300000 }; }
  });
  const before = collectorSnapshot(collector);
  const callsBefore = schedulerCalls;

  const summary = get(http, "/growth/summary");
  const digest = get(http, "/growth/digest", new URLSearchParams({ format: "markdown" }));
  const health = get(http, "/growth/health");
  const notFound = get(http, "/growth/nope");
  assert.ok([summary.status, digest.status, health.status].every(s => s === 200));
  assert.equal(notFound.status, 404);

  // Only the health route consults the scheduler getter, and the getter is
  // a pure read: the reported tickCount is unchanged.
  assert.equal(schedulerCalls, callsBefore + 1);
  assert.equal(health.body.scheduler.tickCount, 7);
  assert.equal(collectorSnapshot(collector), before);
});

test("empty collector yields zeroed summary and a no-activity digest", () => {
  const http = createGrowthHttp({ collector: createCollector() });
  const summary = get(http, "/growth/summary");
  assert.equal(summary.status, 200);
  assert.ok(Object.values(summary.body.totals).every(count => count === 0));
  const digest = get(http, "/growth/digest");
  assert.equal(digest.status, 200);
  assert.match(digest.body.digest, /No activity/);
});
