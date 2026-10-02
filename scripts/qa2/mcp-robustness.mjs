#!/usr/bin/env node
// MCP robustness probe: malformed JSON-RPC, schema-violating tool arguments,
// boundary values and hostile strings against a hosted MCP endpoint.
// Invariants checked on every case:
//   I1 no 5xx; I2 no stack trace / internal path in the body;
//   I3 JSON-RPC envelope is valid (jsonrpc "2.0", matching id, result XOR error);
//   I4 the case's own expectation (error code range, isError, or success).
// Usage: node scripts/qa2/mcp-robustness.mjs --url http://127.0.0.1:4173/mcp [--token-env ROOM_QA_TOKEN] [--room ROOM] [--foreign-room ROOM] [--json out.json] [--writes]
// Read-only unless --writes (then it posts at most 3 messages to --room).
import { argv, env, exit } from "node:process";
import { writeFileSync } from "node:fs";

const arg = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : fallback; };
const has = name => argv.includes(`--${name}`);
const url = arg("url", env.ROOM_QA_MCP_URL || "http://127.0.0.1:4173/mcp");
const token = env[arg("token-env", "ROOM_QA_TOKEN")] || "";
const room = arg("room", env.ROOM_QA_ROOM || "");
const foreignRoom = arg("foreign-room", "muse-room");
const writes = has("writes");
const UA = "project-room-qa2-mcp-robustness/1";

async function rpc(payload, { auth = true, contentType = "application/json", raw = false, accept = "application/json, text/event-stream", method = "POST" } = {}) {
  const headers = { "content-type": contentType, accept, "user-agent": UA };
  if (auth && token) headers.authorization = `Bearer ${token}`;
  const started = performance.now();
  const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : (raw ? payload : JSON.stringify(payload)) });
  const ms = Math.round(performance.now() - started);
  let text = await res.text();
  if (/^(event|data):/m.test(text.slice(0, 40))) text = text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("\n");
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: res.status, ms, text, body };
}

const call = (name, args, id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const LEAK = /(\n\s+at [\w$.<>]+ \(|\/home\/[a-z]|node:internal|TypeError:|ReferenceError:|SQLITE_|"stack":)/;
const big = n => "a".repeat(n);

// expect: "rpcError" (JSON-RPC error object), "toolError" (result.isError true or JSON-RPC error),
//         "ok" (result, not isError), "http4xx" (non-JSON-RPC 4xx acceptable), "any" (only invariants).
const cases = [
  ["parse error", "not json{", { raw: true }, "rpcError"],
  ["empty body", "", { raw: true }, "rpcError"],
  ["missing jsonrpc", { id: 1, method: "tools/list" }, {}, "rpcError"],
  ["wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "tools/list" }, {}, "rpcError"],
  ["unknown method", { jsonrpc: "2.0", id: 2, method: "tools/explode" }, {}, "rpcError"],
  ["method not string", { jsonrpc: "2.0", id: 3, method: 42 }, {}, "rpcError"],
  ["params array", { jsonrpc: "2.0", id: 4, method: "tools/list", params: [] }, {}, "any"],
  ["batch array", [{ jsonrpc: "2.0", id: 5, method: "tools/list" }], {}, "any"],
  ["empty batch", [], {}, "any"],
  ["notification (no id)", { jsonrpc: "2.0", method: "notifications/initialized" }, {}, "any"],
  ["id object", { jsonrpc: "2.0", id: { a: 1 }, method: "tools/list" }, {}, "rpcError"],
  ["text/plain content type", { jsonrpc: "2.0", id: 6, method: "tools/list" }, { contentType: "text/plain" }, "any"],
  ["initialize unsupported version", { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "qa2", version: "1" } } }, {}, "any"],
  ["initialize 2026-07-28", { jsonrpc: "2.0", id: 8, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "qa2", version: "1" } } }, {}, "any"],
  ["ping", { jsonrpc: "2.0", id: 9, method: "ping" }, {}, "ok"],
  ["tools/call no name", { jsonrpc: "2.0", id: 10, method: "tools/call", params: {} }, {}, "toolError"],
  ["tools/call unknown tool", call("room_explode", {}, 11), {}, "toolError"],
  ["tools/call args array", call("room_read_messages", [], 12), {}, "toolError"],
  ["tools/call args string", call("room_read_messages", "x", 13), {}, "toolError"],
  ["missing required roomId", call("room_read_messages", {}, 14), {}, "toolError"],
  ["roomId wrong type", call("room_read_messages", { roomId: 5 }, 15), {}, "toolError"],
  ["roomId traversal", call("room_read_messages", { roomId: "../../etc/passwd" }, 16), {}, "toolError"],
  ["roomId 10k chars", call("room_read_messages", { roomId: big(10000) }, 17), {}, "toolError"],
  ["roomId __proto__", call("room_read_messages", { roomId: "__proto__" }, 18), {}, "toolError"],
  ["extra property", call("room_read_messages", { roomId: room || "x", bogus: 1 }, 19), {}, "toolError"],
  ["limit 0", call("room_read_messages", { roomId: room || "x", limit: 0 }, 20), {}, "toolError"],
  ["limit 101", call("room_read_messages", { roomId: room || "x", limit: 101 }, 21), {}, "toolError"],
  ["limit negative", call("room_read_messages", { roomId: room || "x", limit: -1 }, 22), {}, "toolError"],
  ["limit float", call("room_read_messages", { roomId: room || "x", limit: 1.5 }, 23), {}, "toolError"],
  ["limit string", call("room_read_messages", { roomId: room || "x", limit: "10" }, 24), {}, "toolError"],
  ["after huge", call("room_read_messages", { roomId: room || "x", after: 9007199254740993 }, 25), {}, "any"],
  ["foreign room read (not a member)", call("room_read_messages", { roomId: foreignRoom }, 26), {}, "toolError"],
  ["foreign room post (not a member)", call("room_post_message", { roomId: foreignRoom, body: "qa2 should be refused" }, 27), {}, "toolError"],
  ["post empty body", call("room_post_message", { roomId: room || "x", body: "" }, 28), {}, "toolError"],
  ["post body 65537", call("room_post_message", { roomId: room || "x", body: big(65537) }, 29), {}, "toolError"],
  ["post body null", call("room_post_message", { roomId: room || "x", body: null }, 30), {}, "toolError"],
  ["reply body whitespace", call("room_reply", { roomId: room || "x", requestId: "qa2-ws", replyToId: "nope", body: "   " }, 31), {}, "toolError"],
  ["reply to missing message", call("room_reply", { roomId: room || "x", requestId: "qa2-missing", replyToId: "does-not-exist", body: "hi" }, 32), {}, "toolError"],
  ["unauth room tool", call("room_read_messages", { roomId: room || "x" }, 33), { auth: false }, "toolError"],
  ["GET with SSE accept", null, { method: "GET", accept: "text/event-stream" }, "any"],
];
if (writes && room) {
  cases.push(["post unicode/RTL/zero-width", call("room_post_message", { roomId: room, body: "qa2 \u202Egnirts desrever\u202C \u200B\u200D emoji 🧪 combining e\u0301 <script>alert(1)</script> ${7*7} {{7*7}}" }, 40), {}, "ok"]);
  cases.push(["post NUL byte", call("room_post_message", { roomId: room, body: "qa2 nul\u0000byte" }, 41), {}, "any"]);
  const fixedId = `qa2-idem-${Date.now()}`;
  cases.push(["idempotent post #1", call("room_post_message", { roomId: room, id: fixedId, body: "qa2 idempotency probe" }, 42), {}, "ok"]);
  cases.push(["idempotent post #2 same id", call("room_post_message", { roomId: room, id: fixedId, body: "qa2 idempotency probe" }, 43), {}, "ok"]);
}

const results = [];
for (const [name, payload, opts, expect] of cases) {
  let r;
  try { r = await rpc(payload, opts); } catch (error) { results.push({ name, ok: false, why: `transport: ${error.message}` }); continue; }
  const why = [];
  if (r.status >= 500) why.push(`I1 HTTP ${r.status}`);
  if (LEAK.test(r.text)) why.push("I2 internal detail leaked");
  const b = r.body;
  const isRpc = b && !Array.isArray(b) && typeof b === "object" && b.jsonrpc === "2.0";
  if (isRpc && (("result" in b) === ("error" in b))) why.push("I3 result XOR error violated");
  if (isRpc && payload && typeof payload === "object" && !Array.isArray(payload) && "id" in payload && typeof payload.id !== "object" && b.id !== payload.id && !(b.error && b.id === null)) why.push(`I3 id mismatch ${JSON.stringify(b.id)}`);
  const toolErr = isRpc && (b.error || b.result?.isError === true);
  if (expect === "rpcError" && !(isRpc && b.error) && !(r.status >= 400 && r.status < 500)) why.push(`I4 expected JSON-RPC error, got HTTP ${r.status}`);
  if (expect === "toolError" && !toolErr && !(r.status >= 400 && r.status < 500)) why.push(`I4 expected tool error, got ${r.status} ${r.text.slice(0, 120)}`);
  if (expect === "ok" && !(isRpc && b.result && b.result.isError !== true)) why.push(`I4 expected success, got ${r.status} ${r.text.slice(0, 160)}`);
  results.push({ name, ok: why.length === 0, status: r.status, ms: r.ms, why: why.join("; "), sample: r.text.slice(0, 220) });
}
const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${String(r.status ?? "-").padEnd(4)} ${String(r.ms ?? "").padStart(5)}ms ${r.name}${r.ok ? "" : `  <- ${r.why}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed against ${url}${token ? " (authenticated)" : " (anonymous)"}`);
const out = arg("json"); if (out) writeFileSync(out, JSON.stringify({ url, at: new Date().toISOString(), results }, null, 2));
exit(failed.length ? 1 : 0);
