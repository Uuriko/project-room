// #1566: MCP `room_create` must expose `starter` like POST /api/agent-rooms.
// Contract: the tool's "Same call as POST /api/agent-rooms" description is a
// real promise — `starter: false` skips seeding the starter work-claim task,
// non-boolean `starter` is rejected with invalid_arguments.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-create-starter-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, ...(params === undefined ? {} : { params }) });

function resultValue(response) {
  if (response.error) return { error: response.error.data, message: response.error.message };
  if (response.result?.structuredContent) return response.result.structuredContent;
  const text = response.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return {}; }
}

async function roomCreate(t, args) {
  const { store, rooms } = setup(t);
  const agent = store.identities.create("Starter agent");
  const mcp = createHostedRoomMcp(store, { agentRooms: rooms });
  const response = await mcp(rpc("tools/call", { name: "room_create", arguments: args }), {
    authorization: `Bearer ${agent.secret}`
  });
  return { store, response, value: resultValue(response) };
}

test("room_create inputSchema exposes starter (REST/MCP parity)", async t => {
  const { store } = setup(t);
  const agent = store.identities.create("Lister");
  const mcp = createHostedRoomMcp(store);
  const listed = await mcp(rpc("tools/list", { profile: "full" }), {
    authorization: `Bearer ${agent.secret}`
  });
  const tool = listed.result.tools.find(tool => tool.name === "room_create");
  assert.ok(tool, "room_create missing from tools/list");
  const starter = tool.inputSchema?.properties?.starter;
  assert.ok(starter, "room_create schema omits starter — REST parity broken (#1566)");
  assert.equal(starter.type, "boolean");
});

test("room_create starter:false skips the starter work-claim task", async t => {
  const { value } = await roomCreate(t, {
    roomId: "no-starter-room", title: "No starter", purpose: "Parity check", starter: false
  });
  assert.equal(value.error, undefined, `room_create failed: ${JSON.stringify(value)}`);
  assert.equal(value.roomId, "no-starter-room");
  assert.equal(value.starter, null, "starter:false must skip seeding the starter task");
});

test("room_create rejects non-boolean starter with invalid_arguments", async t => {
  const { value } = await roomCreate(t, {
    roomId: "bad-starter-room", title: "Bad starter", purpose: "Parity check", starter: "yes"
  });
  assert.ok(value.error, "non-boolean starter was accepted — must be rejected");
  assert.equal(value.error.reason, "invalid_arguments");
});
