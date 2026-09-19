import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { roomEntry } from "../deploy/room-entry.mjs";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { MCP_VERSION } from "../client/mcp-stdio.mjs";
import {
  ROOM_MCP_PUBLIC_URL, isRoomMcpPath, roomMcpUrlForHost, roomMcpSnippets, roomMcpJoinText
} from "../src/room-mcp-join.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-join-"));
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

test("hosted MCP join URL is host-exact and secret-free", () => {
  assert.equal(ROOM_MCP_PUBLIC_URL, "https://www.getdasha.com/room/mcp");
  assert.equal(isRoomMcpPath("/room/mcp"), true);
  assert.equal(isRoomMcpPath("/mcp/claude"), true);
  assert.equal(isRoomMcpPath("/room/join.txt"), false);
  assert.equal(roomMcpUrlForHost("https://www.getdasha.com/room"), "https://www.getdasha.com/room/mcp");
  assert.equal(roomMcpUrlForHost("https://www.trydemigod.com/room/mcp"), "https://www.getdasha.com/room/mcp");
  assert.equal(roomMcpUrlForHost("https://project-room-staging.getdasha.workers.dev/room/mcp"), "https://www.getdasha.com/room/mcp");
  assert.equal(roomMcpUrlForHost("http://127.0.0.1:9"), "http://127.0.0.1:9/mcp");
  const snippets = roomMcpSnippets(ROOM_MCP_PUBLIC_URL);
  assert.match(snippets.claude, /claude mcp add --transport http --scope user project-room https:\/\/www\.getdasha\.com\/room\/mcp/);
  assert.equal(snippets.cursor.mcpServers["project-room"].url, ROOM_MCP_PUBLIC_URL);
  assert.match(snippets.codex, /codex mcp add project-room --url https:\/\/www\.getdasha\.com\/room\/mcp/);
  assert.doesNotMatch(roomMcpJoinText(), /Bearer |pri_/);
});

test("MCP join RPC serves packets without initialize session state", () => {
  const listed = handleMcpJoinRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { mcpUrl: ROOM_MCP_PUBLIC_URL });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [
    "room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet"
  ]);
  const init = handleMcpJoinRpc({
    jsonrpc: "2.0", id: 2, method: "initialize",
    params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } }
  }, { mcpUrl: ROOM_MCP_PUBLIC_URL });
  assert.equal(init.result.protocolVersion, MCP_VERSION);
  assert.equal(init.result.serverInfo.name, "project-room");
  const packet = handleMcpJoinRpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "room_join_packet", arguments: {} }
  }, { mcpUrl: ROOM_MCP_PUBLIC_URL });
  assert.match(packet.result.content[0].text, /Agent-native ledger/);
  assert.match(packet.result.content[0].text, /hosted-mcp/);
});

test("Room Worker serves /mcp and /room/mcp as a live join endpoint", async t => {
  const origin = await serve(t);
  for (const path of ["/mcp", "/room/mcp", "/mcp/claude", "/room/mcp/cursor"]) {
    const get = await fetch(`${origin}${path}`);
    assert.equal(get.status, 200, path);
    assert.match(get.headers.get("content-type"), /text\/plain/);
    const text = await get.text();
    assert.match(text, /claude mcp add --transport http/);
    assert.match(text, /codex mcp add project-room/);
    assert.doesNotMatch(text, /Bearer |pri_/);
    const json = await fetch(`${origin}${path}`, { headers: { Accept: "application/json" } });
    assert.match(json.headers.get("content-type"), /application\/json/);
    assert.equal((await json.json()).oauth, false);
    const listed = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list" })
    });
    assert.equal(listed.status, 200, path);
    const body = await listed.json();
    assert.ok(body.result.tools.some(tool => tool.name === "room_mcp_snippet"));
  }
});

test("Demigod door GET /room/mcp is the pasteable join surface", async () => {
  const response = roomEntry(new Request("https://www.trydemigod.com/room/mcp"));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /https:\/\/www\.getdasha\.com\/room\/mcp/);
  const html = await roomEntry(new Request("https://www.trydemigod.com/room")).text();
  assert.match(html, /Add Room as MCP/);
  assert.match(html, /claude mcp add --transport http/);
  assert.match(html, /Join with code/);
  assert.match(html, /ABC-DEF-GHJ/);
});
