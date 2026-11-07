// Route-hit harvest (deep-pass T0 usage-reads, Read 1): the aggregator's
// classification semantics are pinned as ported from the T0 instrument,
// the Workers Observability telemetry shape is accepted, and every bad
// harvest outcome fails with its named error instead of a silent zero.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateRoomRequests, routeFamily } from "../scripts/route-family-aggregate.mjs";
import { buildTelemetryQuery, harvestRouteHits, RouteHitHarvestError } from "../scripts/route-hit-harvest.mjs";

const DAY = "2026-10-25";
const ts = (iso) => Date.parse(iso);

test("classification: named families exact, rest bucketed by two segments, room ids normalised", () => {
  assert.equal(routeFamily("GET", "/demo"), "demo");
  assert.equal(routeFamily("POST", "/demo"), "other:/demo");
  assert.equal(routeFamily("GET", "/api/rooms/room_abcdef123456/code"), "code-drops");
  assert.equal(routeFamily("GET", "/api/rooms/room_abcdef123456/code/xyz/checks"), "code-drops");
  assert.equal(routeFamily("GET", "/api/rooms/room_abcdef123456/squads"), "squads");
  assert.equal(routeFamily("DELETE", "/api/rooms/room_abcdef123456/squads/sq1/disband"), "squads");
  assert.equal(routeFamily("POST", "/mcp"), "mcp");
  assert.equal(routeFamily("POST", "/room/mcp"), "mcp");
  assert.equal(routeFamily("GET", "/api/rooms/room_abcdef123456/messages"), "other:/api/rooms");
});

test("aggregator counts per day with status-class splits across all accepted input shapes", () => {
  const lines = [
    JSON.stringify({ event: "room.request", method: "GET", path: "/demo", status: 200, timestamp: ts(`${DAY}T01:00:00Z`) }),
    JSON.stringify({ logs: [{ message: [JSON.stringify({ event: "room.request", method: "GET", path: "/api/rooms/room_abcdef123456/code", status: 404 })] }], timestamp: ts(`${DAY}T02:00:00Z`) }),
    // Workers Observability telemetry event: payload string under `source`.
    JSON.stringify({ timestamp: ts(`${DAY}T03:00:00Z`), source: JSON.stringify({ event: "room.request", method: "POST", path: "/mcp", status: 200 }), $metadata: { service: "project-room" } }),
    // Telemetry event with the parsed payload under `$metadata.message`.
    JSON.stringify({ timestamp: ts(`${DAY}T04:00:00Z`), $metadata: { service: "project-room", message: JSON.stringify({ event: "room.request", method: "GET", path: "/api/rooms/room_abcdef123456/squads", status: 500 }) } }),
    JSON.stringify({ event: "something.else", timestamp: ts(`${DAY}T05:00:00Z`) }),
    "not json at all"
  ].join("\n");
  const out = aggregateRoomRequests(lines);
  assert.equal(out.totalRoomRequests, 4);
  assert.equal(out.ignoredLines, 2);
  assert.equal(out.days[DAY].demo, 1);
  assert.equal(out.days[DAY]["demo|2xx"], 1);
  assert.equal(out.days[DAY]["code-drops"], 1);
  assert.equal(out.days[DAY]["code-drops|4xx"], 1);
  assert.equal(out.days[DAY].mcp, 1);
  assert.equal(out.days[DAY].squads, 1);
  assert.equal(out.days[DAY]["squads|5xx"], 1);
});

test("telemetry query targets the project-room service in the workers dataset for the day window", () => {
  const query = buildTelemetryQuery(DAY);
  assert.equal(query.view, "events");
  assert.equal(query.timeframe.from, ts(`${DAY}T00:00:00Z`));
  assert.equal(query.timeframe.to, ts(`${DAY}T23:59:59.999Z`));
  assert.deepEqual(query.parameters.datasets, ["cloudflare-workers"]);
  assert.deepEqual(query.parameters.filters, [{ key: "$metadata.service", operation: "eq", type: "string", value: "project-room" }]);
  assert.equal(query.parameters.needle.value, "room.request");
});

const okFetch = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

test("harvest writes the daily JSON for a well-formed reply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "route-hit-harvest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payload = {
    success: true,
    result: {
      events: {
        count: 1,
        events: [{ timestamp: ts(`${DAY}T01:00:00Z`), source: JSON.stringify({ event: "room.request", method: "GET", path: "/demo", status: 200 }) }]
      }
    }
  };
  const { path, record } = await harvestRouteHits({ fetchFn: okFetch(payload), accountId: "acct", token: "tok", day: DAY, outDir: dir });
  assert.equal(record.days[DAY].demo, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), record);
});

test("harvest failures are named: missing secret, token scope, truncation, unexpected shape", async () => {
  const base = { fetchFn: okFetch({ success: true, result: { events: { events: [] } } }), accountId: "acct", token: "tok", day: DAY, outDir: "/nonexistent-out" };
  await assert.rejects(harvestRouteHits({ ...base, token: "" }),
    (e) => e instanceof RouteHitHarvestError && e.code === "ROUTE_HIT_HARVEST_MISSING_SECRET");
  await assert.rejects(harvestRouteHits({ ...base, fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }) }),
    (e) => e.code === "ROUTE_HIT_HARVEST_CF_TOKEN_SCOPE");
  await assert.rejects(harvestRouteHits({ ...base, fetchFn: okFetch({ success: true, result: { events: { count: 5, events: [] } } }) }),
    (e) => e.code === "ROUTE_HIT_HARVEST_TRUNCATED");
  await assert.rejects(harvestRouteHits({ ...base, fetchFn: okFetch({ success: true, result: {} }) }),
    (e) => e.code === "ROUTE_HIT_HARVEST_UNEXPECTED_RESPONSE");
  await assert.rejects(harvestRouteHits({ ...base, fetchFn: okFetch({ success: false, errors: [{ code: 1234 }] }) }),
    (e) => e.code === "ROUTE_HIT_HARVEST_CF_QUERY_FAILED");
});
