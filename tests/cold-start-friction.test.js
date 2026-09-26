// Cold-start friction: MCP error shapes, room-create defaults, land-queue
// pr_not_found, room_react, and replyToId.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { CORE_MCP_TOOLS, MCP_TOOL_NAME_RE } from "../src/room-mcp-join.js";
import { agentErrorAx, errorCategory } from "../src/agent-error.mjs";
import { discoveryDoc, llmsTxt, wellKnownMcpJson } from "../deploy/agent-discovery.mjs";
import { EVENT_TYPES as T, ROOM_KINDS } from "../src/events.js";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-cold-"));
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

test("MCP tools/call names unknown_tool, auth_required, and invalid_arguments", async () => {
  const unknown = handleMcpJoinRpc(rpc("tools/call", { name: "room_post_messag", arguments: {} }));
  assert.equal(unknown.error.code, -32602);
  assert.equal(unknown.error.message, "unknown_tool");
  assert.equal(unknown.error.data.reason, "unknown_tool");
  assert.equal(unknown.error.data.suggestion, "room_post_message");

  const auth = handleMcpJoinRpc(rpc("tools/call", { name: "room_post_message", arguments: { roomId: "commons", body: "hi" } }));
  assert.equal(auth.error.code, -32001);
  assert.equal(auth.error.data.reason, "auth_required");
  assert.match(auth.error.message, /mint one at POST \/api\/agent-identities/);
  assert.equal(auth.error.data.hint, "mint one at POST /api/agent-identities");

  const extra = handleMcpJoinRpc(rpc("tools/call", { name: "room_join_packet", arguments: { token: "nope" } }));
  assert.equal(extra.error.message, "invalid_arguments");
  assert.deepEqual(extra.error.data.unexpected, ["token"]);
  assert.deepEqual(extra.error.data.missing, []);

  const missing = handleMcpJoinRpc(rpc("tools/call", { name: "room_join_packet", arguments: [] }));
  assert.equal(missing.error.data.reason, "invalid_arguments");
  assert.equal(missing.error.data.invalid.arguments, "must be an object");
});

test("authenticated MCP reports field reasons and serves room_react plus replyToId", async t => {
  const { store, rooms } = setup(t);
  const identity = store.identities.create("Ada");
  const created = rooms.create(identity.secret, { title: "Ada room", purpose: "Ship the first post" });
  const mcp = createHostedRoomMcp(store);
  const call = (name, args) => mcp(rpc("tools/call", { name, arguments: args }), { authorization: `Bearer ${identity.secret}` });

  const listed = await mcp(rpc("tools/list"), { authorization: `Bearer ${identity.secret}` });
  assert.equal(listed.result.profile, "core");
  assert.equal(listed.result.tools.length, CORE_MCP_TOOLS.length + 4);
  assert.ok(listed.result.tools.every(tool => MCP_TOOL_NAME_RE.test(tool.name)));
  const full = await mcp(rpc("tools/list", { profile: "full" }), { authorization: `Bearer ${identity.secret}` });
  assert.equal(full.result.tools.some(tool => tool.name === "room_read_board"), true);
  assert.equal(full.result.tools.some(tool => tool.name === "bond.list"), false);

  const longBody = await call("room_post_message", { roomId: created.roomId, body: "x".repeat(4097) });
  assert.equal(longBody.error.message, "invalid_arguments");
  assert.equal(longBody.error.data.invalid.body, "too long");

  const badFile = await call("room_put_file", {
    roomId: created.roomId, id: "file-1", filename: "note.txt", mediaType: "text/plain", data: "not base64!!"
  });
  assert.equal(badFile.error.data.invalid.data, "bad base64");

  const posted = await call("room_post_message", { roomId: created.roomId, body: "Hello" });
  assert.equal(posted.error, undefined);
  assert.equal(posted.result.isError, undefined);
  const post = posted.result.structuredContent;
  assert.equal(typeof post.command.id, "string");
  assert.equal(post.command.data.messageId, post.command.id);
  assert.equal(post.command.data.body, "Hello");

  const reply = await call("room_post_message", {
    roomId: created.roomId, body: "Reply", replyToId: post.command.data.messageId
  });
  assert.equal(reply.result.structuredContent.command.data.replyToId, post.command.data.messageId);

  const reacted = await call("room_react", {
    roomId: created.roomId, messageId: post.command.data.messageId, reaction: "like"
  });
  assert.equal(reacted.result.structuredContent.command.type, "message.reaction_set");
  assert.equal(reacted.result.structuredContent.command.data.active, true);
  const cleared = await call("room_react", {
    roomId: created.roomId, messageId: post.command.data.messageId, reaction: "like", active: false
  });
  assert.equal(cleared.result.structuredContent.command.data.active, false);

  const bonds = await call("bond.list", { roomId: created.roomId });
  assert.equal(bonds.error, undefined);
  assert.equal(bonds.result.structuredContent.command.type, "bond.list");

  const paused = await call("wake.pause", { roomId: created.roomId });
  assert.equal(paused.result.isError, undefined);
  assert.equal(paused.result.structuredContent.receipt.state, "paused");
  const resumed = await call("wake.resume", { roomId: created.roomId, reason: "back" });
  assert.equal(resumed.result.structuredContent.receipt.state, "active");
});

test("room create defaults kind, roomId, and displayName and names the bad field", t => {
  const { store, rooms } = setup(t);
  const identity = store.identities.create("Ada Agent");
  const created = rooms.create(identity.secret, { title: "Ada Room", purpose: "Ship the first post" });
  assert.match(created.roomId, /^ada-room-[0-9a-f]{4}$/);
  assert.equal(created.duplicate, false);
  const state = store.room(created.roomId).state;
  assert.equal(state.room.kind, "personal");
  assert.equal(state.members[identity.identityId].displayName, "Ada Agent");

  const named = rooms.create(identity.secret, {
    roomId: "ada-den", title: "Ada Room", purpose: "Ship the first post"
  });
  assert.equal(named.roomId, "ada-den");
  assert.equal(rooms.create(identity.secret, {
    roomId: "ada-den", title: "Ada Room", purpose: "Ship the first post"
  }).duplicate, true);

  assert.throws(() => rooms.create(identity.secret, {}), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_room_request");
    assert.match(error.message, /title/);
    return true;
  });
  assert.throws(() => rooms.create(identity.secret, { title: "Ada", purpose: "Work", kind: "agent" }), error => {
    assert.match(error.message, /kind/);
    for (const kind of ROOM_KINDS) assert.match(error.message, new RegExp(kind));
    const ax = agentErrorAx({ httpStatus: 422, code: error.code, message: error.message });
    assert.equal(ax.reason, "invalid_room_request");
    assert.equal(ax.next.some(step => step.tool === "room_read_work"), false);
    return true;
  });
});

test("a missing reaction active is invalid_arguments and a no-bearer 401 names self-mint", t => {
  const { store } = setup(t);
  const key = store.issueAccessKey("commons", "owner");
  assert.throws(() => store.command(key, "commons", {
    id: randomUUID(), type: T.MESSAGE_REACTION_SET, data: { messageId: "topic", reaction: "like" }
  }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_arguments");
    assert.equal(errorCategory(error.status, error.code), "input");
    const ax = agentErrorAx({ httpStatus: error.status, code: error.code, message: error.message });
    assert.equal(ax.reason, "invalid_arguments");
    assert.match(ax.hint, /active/);
    assert.equal(ax.next.some(step => step.tool === "room_read_work"), false);
    return true;
  });
  assert.throws(() => store.authenticate(null, "commons"), error => {
    assert.equal(error.status, 401);
    assert.match(error.message, /self-mint an identity/);
    return true;
  });
  const unauth = agentErrorAx({ httpStatus: 401, code: "unauthenticated", message: "No credential" });
  assert.match(unauth.hint, /self-mint/);
  assert.ok(unauth.next.some(step => step.path === "/api/agent-identities"));
  const generic = agentErrorAx({ httpStatus: 422, code: "invalid_command", message: "Unexpected field: channel" });
  assert.equal(generic.next.some(step => step.tool === "room_read_work"), false);
});

test("add_land_item for a missing pull request is 404 pr_not_found and is not stored", async t => {
  const { store } = setup(t);
  store.landQueue.configure({
    fetchImpl: async () => ({ status: 404, ok: false, json: async () => ({ message: "Not Found" }) })
  });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/demo", prNumber: 99999 }),
    error => error.status === 404 && error.code === "pr_not_found"
  );
  assert.equal(store.landQueue.list("commons", "owner").items.length, 0);

  store.landQueue.configure({
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({ message: "Bad credentials" }) })
  });
  await assert.rejects(
    () => store.landQueue.add("commons", "owner", { repo: "acme/private", prNumber: 3 }),
    error => error.status === 503 && error.code === "github_unconfigured"
  );
});

test("llms.txt exposes connection commands and /.well-known/mcp points at hosted MCP", () => {
  const text = llmsTxt();
  assert.match(text, /custom User-Agent/);
  assert.match(text, /\{"title":"Ada room","purpose":"Ship the first post"\}/);
  assert.match(text, /tools\/list/);
  assert.match(text, /room_post_message/);
  const doc = discoveryDoc("/.well-known/mcp");
  assert.equal(doc.type, "application/mcp-server-card+json; charset=utf-8");
  assert.equal(doc.body, wellKnownMcpJson());
  const card = JSON.parse(doc.body);
  assert.equal(card.url, "https://www.getdasha.com/room/mcp");
  assert.equal(card.auth.mint, "https://room.trydemigod.com/api/agent-identities");
  assert.equal(discoveryDoc("/.well-known/mcp.json").body, doc.body);
  assert.equal(discoveryDoc("/room/.well-known/mcp").body, doc.body);
  assert.equal(discoveryDoc("/mcp/server-card").body, doc.body);
  assert.equal(discoveryDoc("/room/mcp/server-card").body, doc.body);
  assert.equal(discoveryDoc("/.well-known/mcp.json"), discoveryDoc("/mcp/server-card"));
});
