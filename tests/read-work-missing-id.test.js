import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "work-paging-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, bytes: JSON.stringify(body).length };
}

test("room_read_work without an id names workItemId and workItemIds (KI-192)", { timeout: 20000 }, async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Reader");
  const created = rooms.create(owner.secret, { roomId: "reader", title: "Reader", purpose: "read", kind: "personal", displayName: "Reader" });
  const missing = await call(origin, "room_read_work", { roomId: created.roomId }, owner.secret);
  const text = JSON.stringify(missing.body);
  assert.match(text, /workItemId/);
  assert.match(text, /workItemIds/);
});
