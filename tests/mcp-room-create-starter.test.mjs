// #1566: MCP room_create must honor `starter` like POST /api/agent-rooms.
// The tool description claims "Same call as POST /api/agent-rooms", and the
// REST route accepts starter (boolean, default true) to skip seeding the
// room's starter work-claim task.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-starter-"));
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
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json();
  return { body, value: body.result?.structuredContent };
}

async function roomCreateSchema(origin, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/list", params: { profile: "full" } }),
  });
  const body = await response.json();
  const tool = body.result.tools.find(t => t.name === "room_create");
  assert.ok(tool, "room_create listed");
  return tool.inputSchema;
}

const hasStarter = (store, roomId) =>
  store.workClaims.list(roomId).some(claim => claim.id === "starter");

test("room_create exposes starter:boolean like POST /api/agent-rooms", async t => {
  const { origin, store } = await serve(t);
  const ada = store.identities.create("Ada");
  const schema = await roomCreateSchema(origin, ada.secret);
  assert.equal(schema.properties?.starter?.type, "boolean", "starter must be a boolean tool param");
  assert.ok(!schema.required?.includes("starter"), "starter stays optional (default true)");
});

test("room_create starter:false skips the starter work-claim task", async t => {
  const { origin, store } = await serve(t);
  const ada = store.identities.create("Ada");
  const created = await call(origin, "room_create", {
    roomId: "starter-off", title: "Starter off", purpose: "No starter task", starter: false,
  }, ada.secret);
  assert.equal(created.body.error, undefined, JSON.stringify(created.body.error));
  assert.equal(created.value.roomId, "starter-off");
  assert.equal(hasStarter(store, "starter-off"), false, "starter:false must not seed the starter claim");
});

test("room_create starter:true (and omission) still seed the starter task", async t => {
  const { origin, store } = await serve(t);
  const ada = store.identities.create("Ada");
  const on = await call(origin, "room_create", {
    roomId: "starter-on", title: "Starter on", purpose: "Starter task", starter: true,
  }, ada.secret);
  assert.equal(on.body.error, undefined);
  assert.equal(hasStarter(store, "starter-on"), true, "starter:true must seed the starter claim");
  const omitted = await call(origin, "room_create", {
    roomId: "starter-default", title: "Starter default", purpose: "Default true",
  }, ada.secret);
  assert.equal(omitted.body.error, undefined);
  assert.equal(hasStarter(store, "starter-default"), true, "omitted starter defaults to true");
});

test("room_create rejects a non-boolean starter", async t => {
  const { origin, store } = await serve(t);
  const ada = store.identities.create("Ada");
  const bad = await call(origin, "room_create", {
    roomId: "starter-bad", title: "Bad", purpose: "Bad starter", starter: "nope",
  }, ada.secret);
  assert.ok(bad.body.error, "non-boolean starter must be rejected");
});
