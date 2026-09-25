// Hosted MCP server card: one document from the live tool lists, served at
// /mcp/server-card and at /.well-known/mcp.json.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry } from "../deploy/room-entry.mjs";
import { MCP_VERSION } from "../client/mcp-stdio.mjs";
import { ROOM_MCP_SERVER_VERSION } from "../src/room-mcp-join.js";
import {
  MCP_DISCOVERY_CACHE_CONTROL, MCP_DISCOVERY_CACHE_SCOPE, MCP_DISCOVERY_TTL_MS,
  MCP_SERVER_CARD_DESCRIPTION, MCP_SERVER_CARD_MEDIA_TYPE, MCP_SERVER_CARD_NAME
} from "../src/mcp-server-card.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-card-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function rpcBody(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
}

test("server card and /.well-known/mcp.json are one document from the live tool lists", async t => {
  const origin = await serve(t);
  const paths = ["/mcp/server-card", "/.well-known/mcp.json", "/room/mcp/server-card", "/room/.well-known/mcp"];
  const responses = [];
  for (const path of paths) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), MCP_SERVER_CARD_MEDIA_TYPE, path);
    assert.equal(response.headers.get("cache-control"), MCP_DISCOVERY_CACHE_CONTROL, path);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    responses.push(await response.text());
  }
  assert.equal(responses[1], responses[0]);
  assert.equal(responses[2], responses[0]);
  assert.equal(responses[3], responses[0]);
  assert.doesNotMatch(responses[0], /pri_[A-Za-z0-9_-]{8,}/);

  const card = JSON.parse(responses[0]);
  assert.equal(card.name, MCP_SERVER_CARD_NAME);
  assert.equal(card.name, registry.name);
  assert.equal(card.description, MCP_SERVER_CARD_DESCRIPTION);
  assert.equal(card.description, registry.description);
  assert.equal(card.description.length <= 100, true);
  assert.equal(card.version, ROOM_MCP_SERVER_VERSION);
  assert.equal(card.url, "https://www.getdasha.com/room/mcp");
  assert.equal(card.remotes[0].url, card.url);
  assert.equal(card.remotes[0].type, "streamable-http");
  assert.equal(card.oauth, false);
  assert.equal(card.auth.mint, "https://room.trydemigod.com/api/agent-identities");
  assert.equal(card.cacheScope, MCP_DISCOVERY_CACHE_SCOPE);
  assert.equal(card.ttlMs, MCP_DISCOVERY_TTL_MS);
  assert.equal(card.cacheScope, "public");

  const listed = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rpcBody("tools/list")
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(card.tools.public, (await listed.json()).result.tools);

  const minted = await fetch(`${origin}/api/agent-identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Card reader" })
  });
  assert.equal(minted.status, 201);
  const { secret } = await minted.json();
  assert.equal(typeof secret, "string");
  const enrolled = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: rpcBody("tools/list")
  });
  assert.equal(enrolled.status, 200);
  const enrolledTools = (await enrolled.json()).result.tools;
  assert.deepEqual(card.tools.enrolled, enrolledTools);
  assert.equal(responses[0].includes(secret), false);
  assert.ok(enrolledTools.length > card.tools.public.length);

  const initialized = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rpcBody("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "card-test", version: "1" }
    })
  });
  assert.equal((await initialized.json()).result.serverInfo.version, card.version);

  const head = await fetch(`${origin}/mcp/server-card`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), MCP_DISCOVERY_CACHE_CONTROL);
  assert.equal(await head.text(), "");

  const options = await fetch(`${origin}/.well-known/mcp.json`, { method: "OPTIONS" });
  assert.equal(options.status, 204);
  assert.match(options.headers.get("access-control-allow-methods") ?? "", /GET/);
  assert.equal(options.headers.get("cache-control"), MCP_DISCOVERY_CACHE_CONTROL);

  const door = roomEntry(new Request("https://www.trydemigod.com/room/mcp/server-card"));
  assert.equal(door.status, 200);
  assert.equal(door.headers.get("content-type"), MCP_SERVER_CARD_MEDIA_TYPE);
  assert.equal(door.headers.get("cache-control"), MCP_DISCOVERY_CACHE_CONTROL);
  assert.equal(door.headers.get("access-control-allow-origin"), "*");
  assert.equal(await door.text(), responses[0]);
  const doorAlias = roomEntry(new Request("https://www.trydemigod.com/room/.well-known/mcp.json"));
  assert.equal(await doorAlias.text(), responses[0]);
  const doorOptions = roomEntry(new Request("https://www.trydemigod.com/room/.well-known/mcp.json", { method: "OPTIONS" }));
  assert.equal(doorOptions.status, 204);
  assert.equal(doorOptions.headers.get("cache-control"), MCP_DISCOVERY_CACHE_CONTROL);
});
