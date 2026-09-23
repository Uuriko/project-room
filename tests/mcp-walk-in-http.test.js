// Walk-in HTTP against shipped createRoomServer. Does not edit frozen MCP sources.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-walk-in-http-"));
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

async function post(origin, message, headers = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(message)
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, retry: res.headers.get("retry-after"), vary: res.headers.get("vary") };
}

test("GET /api/open advertises ship false and no persistence", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/api/open`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ship, false);
  assert.equal(body.persistence, "none");
  assert.equal(body.mcp.endsWith("/mcp"), true);
});

test("initialize then room_join over HTTP is unavailable with empty next", async t => {
  const origin = await serve(t);
  const init = await post(origin, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "walk-in", version: "1" } }
  });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-11-25");
  const join = await post(origin, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "room_join", arguments: { code: "COMMONS", name: "Codex" } }
  });
  assert.equal(join.status, 200);
  assert.equal(join.json.result.isError, true);
  const payload = JSON.parse(join.json.result.content[0].text);
  assert.equal(payload.status, "unavailable");
  assert.deepEqual(payload.next, []);
});

test("pinned MCP-Protocol-Version ping succeeds and echoes Origin", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  assert.match(res.headers.get("vary") || "", /Origin/i);
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: {} });
});

test("GET /.well-known/mcp.json is ship false and mutating needs Authorization", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/.well-known/mcp.json`);
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.ship, false);
  assert.equal(card.authentication.mutating, "authorization-header");
  assert.equal(card.authentication.publicTools, true);
});

test("HTTP tools/list omits private tools; briefing without join is unavailable", async t => {
  const origin = await serve(t);
  const listed = await post(origin, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(listed.status, 200);
  const names = listed.json.result.tools.map(row => row.name);
  assert.equal(names.includes("room_post_draft"), false);
  assert.ok(names.includes("room_check_access"));
  const brief = await post(origin, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "room_briefing", arguments: {} }
  });
  assert.equal(brief.status, 200);
  assert.equal(brief.json.result.isError, true);
  const payload = JSON.parse(brief.json.result.content[0].text);
  assert.equal(payload.status, "unavailable");
  assert.deepEqual(payload.next, []);
});

test("61st POST includes Retry-After", async t => {
  const origin = await serve(t);
  let last;
  for (let i = 0; i < 61; i++) last = await post(origin, { jsonrpc: "2.0", id: i, method: "ping" });
  assert.equal(last.status, 429);
  assert.equal(last.retry, "60");
});
