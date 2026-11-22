#!/usr/bin/env node
// route-hit-harvest.mjs — daily route-hit harvest for the 30-day usage clock
// (deep-pass T0 usage-reads, Read 1).
//
// Queries the Cloudflare Workers Observability API for the production
// `project-room` worker's `room.request` log events over one UTC day
// (default: yesterday), aggregates them with
// scripts/route-family-aggregate.mjs, and writes one JSON file:
//   route-hits-<YYYY-MM-DD>.json
// into --out-dir (default ./route-hits-out). The scheduled workflow
// (.github/workflows/route-hit-harvest.yml) retains that file as a build
// artifact; the fleet files it into the standing clock state dir
// (goals/uuriko-project-room-bug-fix-program/hidden_files/usage-reads/
// route-hits/).
//
// API shape, verified against Cloudflare's public API docs 2026-10-26:
//   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
//   body {queryId, timeframe:{from,to} (epoch ms), view:"events",
//         parameters:{datasets:["cloudflare-workers"], filters, needle}}
//   response result.events = {count, events:[{timestamp, source, $metadata}]}
// Anything unexpected — missing secrets, a non-2xx or success:false reply,
// a truncated event page, an unrecognised response shape — fails LOUDLY
// with a named error and a non-zero exit. This job never reports success
// on data it did not actually aggregate. In particular a 401/403 reply is
// ROUTE_HIT_HARVEST_CF_TOKEN_SCOPE: the first run on main doubles as the
// scope test for the existing CLOUDFLARE_API_TOKEN Actions secret.
//
// Usage: node scripts/route-hit-harvest.mjs [--day YYYY-MM-DD] [--out-dir dir]
// Env:   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (never printed).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateRoomRequests } from "./route-family-aggregate.mjs";

export const WORKER_SERVICE = "project-room";
const DAY_MS = 24 * 60 * 60 * 1000;

export class RouteHitHarvestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RouteHitHarvestError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new RouteHitHarvestError(code, message); };

export function dayWindow(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) fail("ROUTE_HIT_HARVEST_BAD_DAY", `--day must be YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const from = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(from)) fail("ROUTE_HIT_HARVEST_BAD_DAY", `--day is not a real date: ${day}`);
  return { from, to: from + DAY_MS - 1 };
}

export function yesterdayUtc(now = new Date()) {
  return new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
}

export function buildTelemetryQuery(day) {
  const { from, to } = dayWindow(day);
  return {
    queryId: `route-hit-harvest-${day}`,
    timeframe: { from, to },
    view: "events",
    limit: 1000,
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        { key: "$metadata.service", operation: "eq", type: "string", value: WORKER_SERVICE }
      ],
      needle: { value: "room.request", isRegex: false, matchCase: true }
    }
  };
}

export function telemetryEventsToJsonl(payload) {
  if (!payload || typeof payload !== "object") {
    fail("ROUTE_HIT_HARVEST_UNEXPECTED_RESPONSE", "Cloudflare reply was not a JSON object");
  }
  if (payload.success === false) {
    const codes = (payload.errors ?? []).map(e => e?.code ?? "unknown").join(",");
    fail("ROUTE_HIT_HARVEST_CF_QUERY_FAILED", `Cloudflare telemetry query reported success:false (error codes: ${codes || "none given"})`);
  }
  const eventsBox = payload.result?.events;
  const events = Array.isArray(eventsBox) ? eventsBox : eventsBox?.events;
  if (!Array.isArray(events)) {
    fail("ROUTE_HIT_HARVEST_UNEXPECTED_RESPONSE", "Cloudflare reply had no result.events.events array; refusing to aggregate an unrecognised shape");
  }
  const declared = typeof eventsBox?.count === "number" ? eventsBox.count : null;
  if (declared !== null && declared > events.length) {
    fail("ROUTE_HIT_HARVEST_TRUNCATED", `Cloudflare reported ${declared} matching events but returned ${events.length}; a truncated page would undercount the clock, so nothing was written`);
  }
  return events.map(event => JSON.stringify(event)).join("\n");
}

export async function harvestRouteHits({ fetchFn = fetch, accountId, token, day, outDir }) {
  if (!accountId) fail("ROUTE_HIT_HARVEST_MISSING_SECRET", "CLOUDFLARE_ACCOUNT_ID is not set; the harvest cannot query Workers Logs");
  if (!token) fail("ROUTE_HIT_HARVEST_MISSING_SECRET", "CLOUDFLARE_API_TOKEN is not set; the harvest cannot query Workers Logs");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`;
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildTelemetryQuery(day))
    });
  } catch (error) {
    fail("ROUTE_HIT_HARVEST_CF_UNREACHABLE", `Cloudflare telemetry query could not be sent: ${error?.message ?? error}`);
  }
  if (response.status === 401 || response.status === 403) {
    fail("ROUTE_HIT_HARVEST_CF_TOKEN_SCOPE", `Cloudflare telemetry query returned HTTP ${response.status}: the CLOUDFLARE_API_TOKEN Actions secret does not carry Workers Observability read scope (this run is the token-scope test)`);
  }
  if (!response.ok) {
    fail("ROUTE_HIT_HARVEST_CF_QUERY_FAILED", `Cloudflare telemetry query returned HTTP ${response.status}`);
  }
  let payload;
  try { payload = await response.json(); } catch {
    fail("ROUTE_HIT_HARVEST_UNEXPECTED_RESPONSE", "Cloudflare telemetry reply was not JSON");
  }
  const aggregate = aggregateRoomRequests(telemetryEventsToJsonl(payload));
  const record = {
    kind: "route-hits-daily",
    day,
    window: { from: new Date(dayWindow(day).from).toISOString(), to: new Date(dayWindow(day).to).toISOString() },
    worker: WORKER_SERVICE,
    source: "cloudflare-workers-observability",
    ...aggregate
  };
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `route-hits-${day}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return { path, record };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const day = opt("--day") ?? yesterdayUtc();
  const outDir = opt("--out-dir") ?? "route-hits-out";
  try {
    const { path, record } = await harvestRouteHits({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      day, outDir
    });
    console.log(`route-hit harvest: ${record.totalRoomRequests} room.request events for ${day} -> ${path}`);
  } catch (error) {
    const code = error instanceof RouteHitHarvestError ? error.code : "ROUTE_HIT_HARVEST_FAILED";
    console.error(`${code}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
