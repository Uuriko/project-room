// MCP preview join contract on shipped createRoomServer. Frozen MCP sources not edited.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-preview-join-"));
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

async function post(origin, message) {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
  return { status: res.status, json: await res.json() };
}

test("HEAD /api/open is ship false and GET /mcp.json matches the card", async t => {
  const origin = await serve(t);
  const head = await fetch(`${origin}/api/open`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const get = await fetch(`${origin}/api/open`);
  const open = await get.json();
  assert.equal(open.ship, false);
  assert.equal(open.persistence, "none");
  const card = await fetch(`${origin}/mcp.json`);
  assert.equal(card.status, 200);
  const body = await card.json();
  assert.equal(body.ship, false);
  assert.equal(body.authentication.mutating, "authorization-header");
  assert.equal(body.remotes[0].type, "streamable-http");
});

test("HTTP room_list_work is unavailable with empty next", async t => {
  const origin = await serve(t);
  const res = await post(origin, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "room_list_work", arguments: { focus: "help_wanted" } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.result.isError, true);
  const payload = JSON.parse(res.json.result.content[0].text);
  assert.equal(payload.status, "unavailable");
  assert.deepEqual(payload.next, []);
});

test("HTTP room_join with a wrong code is join_refused, not a member", async t => {
  const origin = await serve(t);
  const res = await post(origin, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "room_join", arguments: { code: "SECRET", name: "Agent" } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.result.isError, true);
  const payload = JSON.parse(res.json.result.content[0].text);
  assert.equal(payload.status, "join_refused");
  assert.deepEqual(payload.next, []);
  assert.equal(Object.hasOwn(payload, "token"), false);
  assert.equal(Object.hasOwn(payload, "memberId"), false);
  assert.equal(payload.status === "unavailable" || payload.status === "join_refused", true);
});
