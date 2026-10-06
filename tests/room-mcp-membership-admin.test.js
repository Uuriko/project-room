// UI/REST/MCP parity: agents can mint and revoke agent invites and answer
// access requests over MCP, through the same store calls as the REST routes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-admin-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, isError: body.result?.isError === true };
}

async function listTools(origin, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "l", method: "tools/list", params: { profile: "full" } })
  });
  return (await response.json()).result?.tools ?? [];
}

const ADMIN_TOOLS = ["room_list_access_requests", "room_decide_access_request", "room_create_agent_invite", "room_list_agent_invites", "room_revoke_agent_invite"];

test("owner mints, lists, and revokes agent invites over MCP", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Iris Vale");
  const room = rooms.create(owner.secret, { roomId: "invite-den", title: "Invite den", purpose: "Invites over MCP", kind: "personal", displayName: "Iris Vale" });

  const missingScope = await call(origin, "room_create_agent_invite", { roomId: room.roomId }, owner.secret);
  assert.ok(missingScope.body.error || missingScope.isError, "profile or permissions is required");

  const minted = await call(origin, "room_create_agent_invite", { roomId: room.roomId, profile: "contribute", displayName: "Ada" }, owner.secret);
  assert.equal(minted.isError, false, JSON.stringify(minted.body));
  assert.equal(typeof minted.value.code, "string");
  assert.equal(typeof minted.value.inviteId, "string");

  const listed = await call(origin, "room_list_agent_invites", { roomId: room.roomId }, owner.secret);
  assert.equal(listed.value.roomId, room.roomId);
  const row = listed.value.invites.find(invite => invite.inviteId === minted.value.inviteId);
  assert.ok(row, "minted invite is listed");
  assert.equal(JSON.stringify(listed.value).includes(minted.value.code), false, "raw code is never listed");

  const restListed = await fetch(`${origin}/api/rooms/${room.roomId}/agent-invites`, { headers: { Authorization: `Bearer ${owner.secret}` } });
  assert.equal(restListed.status, 200);
  assert.ok((await restListed.json()).invites.some(invite => invite.inviteId === minted.value.inviteId), "REST sees the MCP invite");

  const revoked = await call(origin, "room_revoke_agent_invite", { roomId: room.roomId, inviteId: minted.value.inviteId }, owner.secret);
  assert.deepEqual(revoked.value, { inviteId: minted.value.inviteId, revoked: true });
  const again = await call(origin, "room_revoke_agent_invite", { roomId: room.roomId, inviteId: minted.value.inviteId }, owner.secret);
  assert.ok(again.body.error || again.isError, "second revoke is refused");

  const redeemed = store.invites.redeem;
  assert.equal(typeof redeemed, "function");
});

test("non-owner member cannot mint invites or list access requests over MCP", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Rowan Hale");
  const room = rooms.create(owner.secret, { roomId: "guard-den", title: "Guard den", purpose: "Grant checks", kind: "personal", displayName: "Rowan Hale" });
  const invite = store.invites.create(owner.secret, room.roomId, { profile: "chat" });
  const guest = store.identities.create("Cleo Park");
  store.invites.redeem(invite.code, { displayName: "Cleo Park", identitySecret: guest.secret });

  const mint = await call(origin, "room_create_agent_invite", { roomId: room.roomId, profile: "chat" }, guest.secret);
  assert.ok(mint.body.error || mint.isError, "chat member has no invite grant");
  const list = await call(origin, "room_list_access_requests", { roomId: room.roomId }, guest.secret);
  assert.ok(list.body.error || list.isError, "chat member cannot read access requests");
});

test("owner lists and decides access requests over MCP", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Dana Moss");
  const room = rooms.create(owner.secret, { roomId: "door-den", title: "Door den", purpose: "Access requests over MCP", kind: "personal", displayName: "Dana Moss" });
  const requester = store.identities.create("Kit Arden");
  const filed = await fetch(`${origin}/api/access-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${requester.secret}` },
    body: JSON.stringify({ roomId: room.roomId, identityId: requester.identityId, displayName: "Kit Arden", requestedPermissions: ["steer"] })
  });
  assert.ok([200, 201, 202].includes(filed.status), `access request filed: ${filed.status} ${await filed.clone().text()}`);

  const pending = await call(origin, "room_list_access_requests", { roomId: room.roomId }, owner.secret);
  assert.equal(pending.isError, false, JSON.stringify(pending.body));
  assert.equal(pending.value.requests.length, 1);
  const requestId = pending.value.requests[0].requestId;

  const bad = await call(origin, "room_decide_access_request", { roomId: room.roomId, requestId, decision: "maybe" }, owner.secret);
  assert.ok(bad.body.error || bad.isError, "decision must be approve or deny");

  const decided = await call(origin, "room_decide_access_request", { roomId: room.roomId, requestId, decision: "approve", note: "welcome" }, owner.secret);
  assert.equal(decided.isError, false, JSON.stringify(decided.body));

  const approved = await call(origin, "room_list_access_requests", { roomId: room.roomId, status: "approved" }, owner.secret);
  assert.ok(approved.value.requests.some(request => request.requestId === requestId), "request is approved");
  const nowPending = await call(origin, "room_list_access_requests", { roomId: room.roomId }, owner.secret);
  assert.equal(nowPending.value.requests.length, 0);
});

test("membership admin tools are in the hosted catalog with schemas", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Cara Lind");
  rooms.create(owner.secret, { roomId: "catalog-den", title: "Catalog den", purpose: "Catalog", kind: "personal", displayName: "Cara Lind" });
  const tools = await listTools(origin, owner.secret);
  const names = tools.map(tool => tool.name);
  for (const name of ADMIN_TOOLS) assert.ok(names.includes(name), `${name} listed`);
  const decide = tools.find(tool => tool.name === "room_decide_access_request");
  assert.deepEqual(decide.inputSchema.required, ["roomId", "requestId", "decision"]);
  assert.equal(decide.annotations.readOnlyHint, false);
});
