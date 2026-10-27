// NEXT-1 latency: Server-Timing phases on API + /mcp responses, and the
// one structured perf log line per measured request. Phase names are the
// stable set from server/http.mjs (PERF_PHASES): body, handler, serialise,
// total — auth and store work are interleaved inside handlers and stay
// inside `handler` (see the PERF_PHASES comment in server/http.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer, formatServerTiming, isPerfMeasuredPath, perfLogLine, perfPhases, perfSegmentsMs } from "../server/http.mjs";
import { parseServerTiming, percentile } from "../scripts/prod-latency-probe.mjs";

const TIMING_SHAPE = /^body;dur=\d+, handler;dur=\d+, serialise;dur=\d+, total;dur=\d+$/;

test("perf helpers: Server-Timing shape, segment union, phase split", () => {
  assert.equal(formatServerTiming({ body: 1.4, handler: 23.6, serialise: 0.2, total: 25.2 }),
    "body;dur=1, handler;dur=24, serialise;dur=0, total;dur=25");
  assert.equal(formatServerTiming({}), "body;dur=0, handler;dur=0, serialise;dur=0, total;dur=0");
  // Overlapping segments count once; disjoint segments add up.
  assert.equal(perfSegmentsMs([[0, 10], [5, 12]]), 12);
  assert.equal(perfSegmentsMs([[0, 10], [20, 25]]), 15);
  assert.equal(perfSegmentsMs([]), 0);
  const phases = perfPhases({ started: 100, bodySegments: [[100, 110]], serialiseSegments: [[130, 135]] }, 200);
  assert.deepEqual(phases, { body: 10, handler: 85, serialise: 5, total: 100 });
  assert.equal(isPerfMeasuredPath("/api/health"), true);
  assert.equal(isPerfMeasuredPath("/api/rooms/x/events"), true);
  assert.equal(isPerfMeasuredPath("/mcp"), true);
  assert.equal(isPerfMeasuredPath("/room/mcp"), true);
  assert.equal(isPerfMeasuredPath("/room/api/health"), true);
  assert.equal(isPerfMeasuredPath("/favicon.svg"), false);
  assert.equal(isPerfMeasuredPath("/"), false);
  assert.equal(isPerfMeasuredPath(null), false);
});

test("perf log line: one structured JSON line with method, route, status and phases", () => {
  const line = JSON.parse(perfLogLine({ method: "GET", route: "/api/rooms/:item", status: 200,
    phases: { body: 0, handler: 12, serialise: 1, total: 13 } }));
  assert.deepEqual(line, { event: "room.perf", method: "GET", route: "/api/rooms/:item", status: 200,
    totalMs: 13, phases: { body: 0, handler: 12, serialise: 1 } });
});

test("probe helpers: Server-Timing parsing takes the first value per phase", () => {
  assert.deepEqual(parseServerTiming("body;dur=1, handler;dur=23, serialise;dur=0, total;dur=24, app;dur=30, total;dur=99"),
    { body: 1, handler: 23, serialise: 0, total: 24, app: 30 });
  assert.deepEqual(parseServerTiming(null), {});
  assert.equal(percentile([10, 20, 30], 50), 20);
  assert.equal(percentile([], 95), null);
});

// Capture only room.perf lines emitted while fn runs.
async function capturePerfLines(fn) {
  const lines = [];
  const original = console.info;
  console.info = (...args) => {
    const text = args.map(String).join(" ");
    if (text.includes("\"room.perf\"")) lines.push(JSON.parse(text));
    else original(...args);
  };
  try { return { result: await fn(), lines }; }
  finally { console.info = original; }
}

function fixtureServer(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return { f, server };
}

test("Server-Timing + perf log on an API route and on a room read", async t => {
  const { f, server } = fixtureServer(t);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;

  const health = await capturePerfLines(async () => {
    const response = await fetch(origin + "/api/health");
    await response.text();
    return response;
  });
  assert.equal(health.result.status, 200);
  assert.match(health.result.headers.get("server-timing") ?? "", TIMING_SHAPE);
  assert.equal(health.lines.length, 1, "exactly one perf log line per measured request");
  assert.equal(health.lines[0].event, "room.perf");
  assert.equal(health.lines[0].method, "GET");
  assert.equal(health.lines[0].route, "/api/health");
  assert.equal(health.lines[0].status, 200);
  assert.equal(typeof health.lines[0].totalMs, "number");
  assert.deepEqual(Object.keys(health.lines[0].phases), ["body", "handler", "serialise"]);

  const snapshot = await capturePerfLines(async () => {
    const response = await fetch(origin + "/api/rooms/commons", { headers: { Authorization: `Bearer ${f.keys.owner}` } });
    await response.text();
    return response;
  });
  assert.equal(snapshot.result.status, 200);
  assert.match(snapshot.result.headers.get("server-timing") ?? "", TIMING_SHAPE);
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0].method, "GET");
  assert.equal(snapshot.lines[0].status, 200);
});

test("Server-Timing + perf log on /mcp tools/list, and a POST body route", async t => {
  const { f, server } = fixtureServer(t);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;

  const mcp = await capturePerfLines(async () => {
    const response = await fetch(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }) });
    await response.text();
    return response;
  });
  assert.equal(mcp.result.status, 200);
  assert.match(mcp.result.headers.get("server-timing") ?? "", TIMING_SHAPE);
  assert.equal(mcp.lines.length, 1);
  assert.equal(mcp.lines[0].route, "/mcp");
  assert.equal(mcp.lines[0].method, "POST");
  assert.equal(mcp.lines[0].status, 200);

  const post = await capturePerfLines(async () => {
    const response = await fetch(origin + "/api/rooms/commons/commands", { method: "POST",
      headers: { Authorization: `Bearer ${f.keys.owner}`, "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ id: crypto.randomUUID(), type: "message.posted", data: { messageId: "perf-timing-1", body: "perf timing test post" } }) });
    await response.text();
    return response;
  });
  assert.equal(post.result.status, 201);
  assert.match(post.result.headers.get("server-timing") ?? "", TIMING_SHAPE);
  assert.equal(post.lines.length, 1);
  assert.equal(post.lines[0].status, 201);
  assert.equal(typeof post.lines[0].phases.body, "number");
});

test("non-measured paths get no Server-Timing header and no perf log line", async t => {
  const { server } = fixtureServer(t);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const page = await capturePerfLines(async () => {
    const response = await fetch(origin + "/favicon.svg");
    await response.text();
    return response;
  });
  assert.equal(page.result.status, 200);
  assert.equal(page.result.headers.get("server-timing"), null);
  assert.equal(page.lines.length, 0);
});
