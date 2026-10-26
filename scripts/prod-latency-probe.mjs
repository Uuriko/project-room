// NEXT-1 latency probe: measures the 8-call set below against a base URL
// and reports per-call p50/p95 against the NEXT-1 targets (board targets,
// not guarantees): read p50 < 150 ms, post p50 < 200 ms, /mcp tools/list
// p50 < 150 ms, and p95 < 1 s across the measured calls.
//
// Server-Timing phases (added by server/http.mjs, NEXT-1): when the server
// sends a Server-Timing header the probe prints the per-phase p50 split.
// Phase names are stable: body (request-body read), handler (routing,
// auth, store and handler work), serialise (JSON.stringify), total
// (request start to response writeHead). On a deployment whose outer
// Worker layer appends its own app/total metrics, the first value per
// phase name is the handler-side one and is what this probe reads.
// A base that predates NEXT-1 sends no handler-side phases (the Worker
// layer may still send app/total); the probe then prints phases as "-"
// and the timings stand as the pre-NEXT-1 baseline.
//
// Calls (reads n = --samples, default 10, after 1 uncounted warmup):
//   health            GET  /api/health
//   health-jobs       GET  /api/health/jobs
//   room-snapshot     GET  /api/rooms/<room>                    (needs --room + token)
//   room-events       GET  /api/rooms/<room>/events?after=0&limit=20
//   room-search       GET  /api/rooms/<room>/search?q=<query>
//   mcp-tools-list    POST /mcp  tools/list
//   mcp-read          POST /mcp  tools/call room_read_messages (needs --room + MCP token)
//                                or room_join_packet (public, no credential)
//   post-message      POST /api/rooms/<post-room>/commands     (only with --post-room)
//
// Usage:
//   node scripts/prod-latency-probe.mjs --base https://room.trydemigod.com [--room <id>]
//     [--post-room <qa-room-id>] [--samples 10] [--post-samples 3] [--query <text>] [--json]
//
// Credentials come from the environment only and are never printed:
//   ROOM_PROBE_TOKEN      Bearer token for the API room reads (access key)
//   ROOM_PROBE_KEY        alias of ROOM_PROBE_TOKEN
//   ROOM_PROBE_MCP_TOKEN  Bearer identity secret for the authenticated MCP read
//
// Safety: post-message runs only when --post-room is given, and against a
// non-loopback base the post room id must start with "qa-" (qa- rooms only
// on prod; purge the room afterwards). Room calls without --room/token are
// reported as skipped, never guessed.

import { pathToFileURL } from "node:url";

export function parseServerTiming(header) {
  const phases = {};
  if (typeof header !== "string") return phases;
  for (const part of header.split(",")) {
    const match = /^\s*([a-z][a-z0-9-]*);dur=(\d+(?:\.\d+)?)\s*$/i.exec(part);
    if (match && phases[match[1]] === undefined) phases[match[1]] = Number(match[2]);
  }
  return phases;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

async function main() {
const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const hasFlag = name => args.includes(name);
const base = flag("--base");
const room = flag("--room");
const postRoom = flag("--post-room");
const samples = Number(flag("--samples") ?? 10);
const postSamples = Number(flag("--post-samples") ?? 3);
const query = flag("--query") ?? "room";
const asJson = hasFlag("--json");
const token = process.env.ROOM_PROBE_TOKEN || process.env.ROOM_PROBE_KEY || "";
const mcpToken = process.env.ROOM_PROBE_MCP_TOKEN || "";

if (!base || !/^https?:\/\//.test(base) || !Number.isInteger(samples) || samples < 1
  || !Number.isInteger(postSamples) || postSamples < 1) {
  process.stderr.write("Usage: node scripts/prod-latency-probe.mjs --base <url> [--room <id>] [--post-room <qa-id>] [--samples 10] [--post-samples 3] [--query <text>] [--json]\n");
  process.exit(1);
}
const baseUrl = base.replace(/\/+$/, "");
const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(baseUrl);
if (postRoom && !isLoopback && !postRoom.startsWith("qa-")) {
  process.stderr.write(`Refusing to post: --post-room "${postRoom}" is not a qa- room and the base is not loopback.\n`);
  process.exit(1);
}
if (postRoom && !token) {
  process.stderr.write("Refusing to post: ROOM_PROBE_TOKEN (or ROOM_PROBE_KEY) is not set.\n");
  process.exit(1);
}

const TARGETS = { read: 150, post: 200, mcpList: 150, p95: 1000 };

async function measureOnce(call) {
  const started = performance.now();
  let status = 0;
  let serverTiming = null;
  try {
    const response = await fetch(baseUrl + call.path, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    status = response.status;
    serverTiming = response.headers.get("server-timing");
    await response.text();
  } catch {
    status = 0;
  }
  return { ms: performance.now() - started, status, phases: parseServerTiming(serverTiming) };
}

async function measureCall(call, count) {
  await measureOnce(call); // warmup, uncounted
  const runs = [];
  for (let i = 0; i < count; i++) runs.push(await measureOnce(call));
  const times = runs.map(run => run.ms);
  const phaseNames = ["body", "handler", "serialise", "total"];
  const phases = {};
  for (const name of phaseNames) {
    const values = runs.map(run => run.phases[name]).filter(value => Number.isFinite(value));
    if (values.length) phases[name] = Math.round(percentile(values, 50));
  }
  return {
    call: call.id, n: runs.length,
    statuses: [...new Set(runs.map(run => run.status))],
    p50: Math.round(percentile(times, 50)), p95: Math.round(percentile(times, 95)),
    target: call.target, met: percentile(times, 50) < call.target && percentile(times, 95) < TARGETS.p95,
    phases
  };
}

const bearerHeaders = token ? { Authorization: `Bearer ${token}` } : {};
const jsonHeaders = { "Content-Type": "application/json" };
const mcpBody = (method, params) => JSON.stringify({ jsonrpc: "2.0", id: "probe", method, ...(params ? { params } : {}) });

const calls = [
  { id: "health", method: "GET", path: "/api/health", target: TARGETS.read, headers: {} },
  { id: "health-jobs", method: "GET", path: "/api/health/jobs", target: TARGETS.read, headers: {} },
  ...(room && token ? [
    { id: "room-snapshot", method: "GET", path: `/api/rooms/${encodeURIComponent(room)}`, target: TARGETS.read, headers: bearerHeaders },
    { id: "room-events", method: "GET", path: `/api/rooms/${encodeURIComponent(room)}/events?after=0&limit=20`, target: TARGETS.read, headers: bearerHeaders },
    { id: "room-search", method: "GET", path: `/api/rooms/${encodeURIComponent(room)}/search?q=${encodeURIComponent(query)}`, target: TARGETS.read, headers: bearerHeaders }
  ] : []),
  { id: "mcp-tools-list", method: "POST", path: "/mcp", target: TARGETS.mcpList, headers: jsonHeaders, body: mcpBody("tools/list") },
  (room && mcpToken
    ? { id: "mcp-read", method: "POST", path: "/mcp", target: TARGETS.read,
        headers: { ...jsonHeaders, Authorization: `Bearer ${mcpToken}` },
        body: mcpBody("tools/call", { name: "room_read_messages", arguments: { roomId: room, limit: 20 } }) }
    : { id: "mcp-read", method: "POST", path: "/mcp", target: TARGETS.read, headers: jsonHeaders,
        body: mcpBody("tools/call", { name: "room_join_packet", arguments: {} }) }),
  ...(postRoom ? [{
    id: "post-message", method: "POST", path: `/api/rooms/${encodeURIComponent(postRoom)}/commands`, target: TARGETS.post,
    headers: { ...jsonHeaders, ...bearerHeaders },
    // A fresh command/message id per sample is set in main() below.
    body: null, post: true
  }] : [])
];

const skipped = [];
if (!(room && token)) skipped.push("room-snapshot, room-events, room-search (need --room and ROOM_PROBE_TOKEN/ROOM_PROBE_KEY)");
if (!postRoom) skipped.push("post-message (needs --post-room; qa- room only on a non-loopback base)");

const results = [];
for (const call of calls) {
  if (call.post) {
    const postCall = { ...call };
    const runs = [];
    for (let i = 0; i < postSamples; i++) {
      postCall.body = JSON.stringify({ id: crypto.randomUUID(), type: "message.posted",
        data: { messageId: `probe-${Date.now()}-${i}`, body: "NEXT-1 latency probe (qa room; purge after)" } });
      runs.push(await measureOnce(postCall));
    }
    const times = runs.map(run => run.ms);
    const phases = {};
    for (const name of ["body", "handler", "serialise", "total"]) {
      const values = runs.map(run => run.phases[name]).filter(value => Number.isFinite(value));
      if (values.length) phases[name] = Math.round(percentile(values, 50));
    }
    results.push({ call: call.id, n: runs.length, statuses: [...new Set(runs.map(run => run.status))],
      p50: Math.round(percentile(times, 50)), p95: Math.round(percentile(times, 95)),
      target: call.target, met: percentile(times, 50) < call.target && percentile(times, 95) < TARGETS.p95, phases });
  } else {
    results.push(await measureCall(call, samples));
  }
}

if (asJson) {
  console.log(JSON.stringify({ base: baseUrl, targets: TARGETS, results, skipped }, null, 2));
} else {
  console.log(`NEXT-1 latency probe — base ${baseUrl}`);
  console.log(`Targets: read p50 <${TARGETS.read}ms · post p50 <${TARGETS.post}ms · tools/list p50 <${TARGETS.mcpList}ms · p95 <${TARGETS.p95}ms`);
  console.log("");
  console.log("call             n   p50(ms)  p95(ms)  target  met?  statuses");
  for (const result of results) {
    console.log(`${result.call.padEnd(16)} ${String(result.n).padStart(2)}  ${String(result.p50).padStart(6)}  ${String(result.p95).padStart(6)}  ${String(result.target).padStart(5)}ms  ${result.met ? "yes" : "NO"}    ${result.statuses.join(",")}`);
    const phaseText = ["body", "handler", "serialise", "total"].map(name => `${name}=${result.phases[name] ?? "-"}`).join(" ");
    console.log(`${"".padEnd(16)} phases p50: ${phaseText}`);
  }
  for (const note of skipped) console.log(`skipped: ${note}`);
}
}
