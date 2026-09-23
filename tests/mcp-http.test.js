import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { publicTools, PUBLIC_MCP_INSTRUCTIONS, handlePublicMcpMessage, mcpOriginAllowed } from "../client/mcp-public.mjs";
import { openJoinContract, OPEN_CODE } from "../server/open-contract.mjs";
import { agentJoinNotice } from "../src/agent-join-notice.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

const FORBIDDEN = /ROOM_AGENT_TOKEN|sk-|password|@gmail/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function mcp(origin, message, headers = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(message)
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, allow: response.headers.get("access-control-allow-origin"), body };
}

test("OPEN-JOIN.md matches preview contract, not CORS star or joined_ephemeral", () => {
  const doc = readFileSync(pathJoin(dirname(fileURLToPath(import.meta.url)), "../docs/OPEN-JOIN.md"), "utf8");
  assert.match(doc, /ship: false/);
  assert.doesNotMatch(doc, /joined_ephemeral/);
  assert.doesNotMatch(doc, /CORS `\*`/);
  assert.match(doc, /unavailable/);
});

test("open contract is preview, commons-only, and secret-free", () => {
  const contract = openJoinContract({ origin: "https://project-room-staging.getdasha.workers.dev" });
  assert.equal(contract.room, "commons");
  assert.equal(contract.code, OPEN_CODE);
  assert.equal(contract.mint, "self_join_preview");
  assert.equal(contract.ship, false);
  assert.equal(contract.account, false);
  assert.equal(contract.persistence, "none");
  assert.doesNotMatch(JSON.stringify(contract), FORBIDDEN);
});

test("public MCP catalog is small and does not include private work tools", () => {
  const names = publicTools.map(row => row.name);
  assert.deepEqual(names, ["room_join", "room_briefing", "room_list_work", "room_listen", "room_check_access"]);
  assert.equal(names.includes("room_post_draft"), false);
  assert.match(PUBLIC_MCP_INSTRUCTIONS, /Stop after tools\/list/);
  assert.doesNotMatch(PUBLIC_MCP_INSTRUCTIONS, /keep room_listen/);
});

test("initialize and tools/list work without an account", async t => {
  const origin = await serve(t);
  const started = await mcp(origin, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.result.serverInfo.name, "project-room");
  const listed = await mcp(origin, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.body.result.tools.map(row => row.name), publicTools.map(row => row.name));
});

test("GET /api/open, mcp card, CORS preflight, GET 405", async t => {
  const origin = await serve(t);
  const open = await fetch(`${origin}/api/open`);
  assert.equal((await open.json()).ship, false);
  const card = await fetch(`${origin}/.well-known/mcp.json`);
  assert.equal((await card.json()).ship, false);
  const options = await fetch(`${origin}/mcp`, { method: "OPTIONS" });
  assert.equal(options.status, 204);
  const get = await fetch(`${origin}/mcp`);
  assert.equal(get.status, 405);
  assert.match(get.headers.get("allow") || "", /POST/);
  const head = await fetch(`${origin}/mcp`, { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.match(head.headers.get("allow") || "", /POST/);
  const noType = await fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
  assert.equal(noType.status, 415);
});

test("untrusted Origin is 403 without CORS star; OPTIONS too; pinned initialize", async t => {
  const origin = await serve(t);
  const badOrigin = await mcp(origin, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://untrusted.example" });
  assert.equal(badOrigin.status, 403);
  assert.notEqual(badOrigin.allow, "*");
  const badVer = await mcp(origin, { jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "not-supported" });
  assert.equal(badVer.status, 400);
  const okLoop = await mcp(origin, { jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: origin });
  assert.equal(okLoop.status, 200);
  assert.equal(okLoop.allow, origin);
  assert.notEqual(okLoop.allow, "*");
  const varyRes = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  });
  assert.equal(varyRes.status, 200);
  assert.match(varyRes.headers.get("vary") || "", /Origin/i);
  const badOpt = await fetch(`${origin}/mcp`, { method: "OPTIONS", headers: { Origin: "https://untrusted.example" } });
  assert.equal(badOpt.status, 403);
  assert.notEqual(badOpt.headers.get("access-control-allow-origin"), "*");
  const staleInit = await mcp(origin, {
    jsonrpc: "2.0", id: 3, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } }
  });
  assert.equal(staleInit.status, 200);
  assert.equal(staleInit.body.error.code, -32602);
  const pinned = await mcp(origin, {
    jsonrpc: "2.0", id: 4, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } }
  });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.result.protocolVersion, "2025-11-25");
});

test("HTTP tools/list with array params and JSON array body fail on the real route", async t => {
  const origin = await serve(t);
  const listed = await mcp(origin, { jsonrpc: "2.0", id: 21, method: "tools/list", params: [] });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.error.code, -32602);
  const batch = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])
  });
  assert.equal(batch.status, 400);
});

test("HTTP tools/call with null arguments is 200 JSON-RPC error -32602", async t => {
  const origin = await serve(t);
  const r = await mcp(origin, {
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { name: "room_check_access", arguments: null }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.error.code, -32602);
});

test("object JSON-RPC ids, null arguments, and array params fail", () => {
  const badId = handlePublicMcpMessage({ jsonrpc: "2.0", id: { n: 1 }, method: "ping" });
  assert.equal(badId.error.code, -32600);
  const listen = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "room_listen", arguments: { code: "COMMONS", name: "A", timeoutMs: -1 } }
  });
  assert.equal(listen.error.code, -32602);
  const nullArgs = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 9, method: "tools/call",
    params: { name: "room_check_access", arguments: null }
  });
  assert.equal(nullArgs.error.code, -32602);
  const listArray = handlePublicMcpMessage({ jsonrpc: "2.0", id: 10, method: "tools/list", params: [] });
  assert.equal(listArray.error.code, -32602);
  const omitted = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 11, method: "tools/call",
    params: { name: "room_check_access" }
  });
  assert.equal(omitted.result.isError, false);
});

test("preview join is unavailable; no success then join_required loop", () => {
  const joined = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "room_join", arguments: { code: "COMMONS", name: "Codex" } }
  });
  const body = JSON.parse(joined.result.content[0].text);
  assert.equal(joined.result.isError, true);
  assert.equal(body.status, "unavailable");
  assert.deepEqual(body.next, []);
  assert.notEqual(body.status, "joined_ephemeral");
  const brief = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "room_briefing", arguments: {} }
  });
  assert.equal(JSON.parse(brief.result.content[0].text).status, "unavailable");
  const draft = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "room_post_draft", arguments: {} }
  });
  assert.equal(draft.error.code, -32602);
});

test("join page notice tells agents to stop", () => {
  const lines = agentJoinNotice({ mcpUrl: "https://example.test/mcp" });
  assert.equal(lines.some(line => /do not fill in the join form/i.test(line)), true);
  assert.equal(lines.some(line => /Stop after tools\/list/.test(line)), true);
  assert.doesNotMatch(lines.join("\n"), FORBIDDEN);
});

test("loopback Origin policy", () => {
  assert.equal(mcpOriginAllowed(undefined, "http://127.0.0.1:9"), true);
  assert.equal(mcpOriginAllowed("http://127.0.0.1:9", "http://127.0.0.1:9"), true);
  assert.equal(mcpOriginAllowed("https://untrusted.example", "http://127.0.0.1:9"), false);
  assert.equal(mcpOriginAllowed("https://untrusted.example", "https://project-room-staging.getdasha.workers.dev"), false);
  assert.equal(mcpOriginAllowed("https://project-room-staging.getdasha.workers.dev", "https://project-room-staging.getdasha.workers.dev"), true);
});

test("notifications have no JSON-RPC id and extra tool fields are rejected", async t => {
  const origin = await serve(t);
  const note = await mcp(origin, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  const extra = handlePublicMcpMessage({
    jsonrpc: "2.0", id: 12, method: "tools/call",
    params: { name: "room_join", arguments: { code: "COMMONS", name: "A", extra: true } }
  });
  assert.equal(extra.error.code, -32602);
});

test("request 61 from one address is rate limited", async t => {
  const origin = await serve(t);
  let last = 200;
  for (let i = 0; i < 61; i++) {
    const r = await mcp(origin, { jsonrpc: "2.0", id: i, method: "ping" });
    last = r.status;
  }
  assert.equal(last, 429);
});
