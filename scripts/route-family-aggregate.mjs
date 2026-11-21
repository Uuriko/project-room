#!/usr/bin/env node
// route-family-aggregate.mjs — aggregates production `room.request` log
// lines (emitted per request by cloudflare/request-timing.mjs
// logRoomRequest at the worker fetch wrapper) into per-day, per-route-family
// hit counts. Ported verbatim in classification semantics from the deep-pass
// T0 usage-reads instrument (wave-2026-10-26-deep-pass-t0/lane-usage-reads/
// route-family-aggregate.mjs, specimen-tested there), extended with one
// input shape: Workers Observability telemetry events, whose log payload
// rides under `source` (string or object) / `$metadata.message`.
//
// ACCEPTED INPUT (JSONL text):
//   a) raw console lines: {"event":"room.request","method":"GET","path":"/demo","status":200,...}
//      optionally with a "timestamp"/"$metadata.timestamp" field (ms or ISO).
//   b) wrangler tail --format json events: {"logs":[{"message":["{...room.request json...}"]}], "timestamp": ...}
//   c) Workers Logs / Logpush export rows whose fields include the parsed
//      message object under .message or the raw line under .message string.
//   d) Workers Observability telemetry events: {"timestamp":..., "source": "..."}
//      or {"timestamp":..., "$metadata": {"message": "..."}}.
// Lines that are not room.request events are counted as `ignored` and dropped.
//
// FAMILY CLASSIFICATION (route table at 927a6420; {roomId}/{id} segments are
// normalised to {} before matching):
//   demo       = GET/HEAD /demo exactly
//   code-drops = /api/rooms/{}/code[/{}[/checks|/raw]]
//   squads     = /api/rooms/{}/squads[/{}[/members|/disband]]
//   mcp        = /mcp or /room/mcp  (COUNT ONLY: the log line carries no body,
//                so per-tool MCP counts can NEVER come from this source)
//   everything else is bucketed by its first two path segments.
//
// OUTPUT: JSON {generatedAt, totalRoomRequests, ignoredLines,
//               days: {YYYY-MM-DD: {family: n, "family|Nxx": n}}}
// One output file per harvest day feeds the 30-day route-hit clock.
//
// Usage: node scripts/route-family-aggregate.mjs [--file in.jsonl] [--out out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const normalize = (p) => p.replace(/\/[A-Za-z0-9_-]{8,}/g, "/{}").replace(/\/pwr_[a-f0-9]+/g, "/{}");
export function routeFamily(method, rawPath) {
  const p = normalize(rawPath);
  if ((method === "GET" || method === "HEAD") && p === "/demo") return "demo";
  if (/^\/api\/rooms\/\{\}\/code(\/.*)?$/.test(p)) return "code-drops";
  if (/^\/api\/rooms\/\{\}\/squads(\/.*)?$/.test(p)) return "squads";
  if (p === "/mcp" || p === "/room/mcp") return "mcp";
  const seg = p.split("/").filter(Boolean).slice(0, 2).join("/");
  return `other:/${seg}`;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function* roomRequests(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  const candidates = [];
  if (obj?.event === "room.request") candidates.push(obj);
  if (Array.isArray(obj?.logs)) for (const l of obj.logs) for (const m of l.message ?? []) {
    const parsed = parseMaybeJson(m);
    if (parsed?.event === "room.request") candidates.push({ ...parsed, timestamp: obj.timestamp });
  }
  if (typeof obj?.message === "string") {
    const parsed = parseMaybeJson(obj.message);
    if (parsed?.event === "room.request") candidates.push({ ...parsed, timestamp: obj.timestamp ?? obj.$metadata?.timestamp });
  }
  if (obj?.message?.event === "room.request") candidates.push({ ...obj.message, timestamp: obj.timestamp ?? obj.$metadata?.timestamp });
  // Workers Observability telemetry events: payload under `source`
  // (string or object) or the message text under `$metadata.message`.
  const source = typeof obj?.source === "string" ? parseMaybeJson(obj.source) : obj?.source;
  if (source?.event === "room.request") candidates.push({ ...source, timestamp: obj.timestamp ?? source.timestamp });
  if (typeof obj?.$metadata?.message === "string") {
    const parsed = parseMaybeJson(obj.$metadata.message);
    if (parsed?.event === "room.request") candidates.push({ ...parsed, timestamp: obj.timestamp ?? obj.$metadata?.timestamp });
  }
  yield* candidates;
}

export function aggregateRoomRequests(input) {
  const days = {};
  let ignored = 0, total = 0;
  for (const line of String(input).split("\n")) {
    if (!line.trim()) continue;
    let found = false;
    for (const ev of roomRequests(line)) {
      found = true; total += 1;
      const ts = ev.timestamp ?? ev.$metadata?.timestamp;
      const day = ts ? new Date(typeof ts === "number" ? ts : Date.parse(ts)).toISOString().slice(0, 10) : "undated";
      const fam = routeFamily(ev.method ?? "?", ev.path ?? "/");
      days[day] ??= {};
      days[day][fam] = (days[day][fam] ?? 0) + 1;
      const statusClass = `${Math.floor((ev.status ?? 0) / 100)}xx`;
      days[day][`${fam}|${statusClass}`] = (days[day][`${fam}|${statusClass}`] ?? 0) + 1;
    }
    if (!found) ignored += 1;
  }
  return { generatedAt: new Date().toISOString(), totalRoomRequests: total, ignoredLines: ignored, days };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const input = opt("--file") ? readFileSync(opt("--file"), "utf8") : readFileSync(0, "utf8");
  const out = aggregateRoomRequests(input);
  if (opt("--out")) writeFileSync(opt("--out"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
