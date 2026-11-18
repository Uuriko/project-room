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
import { initialRoom } from "../server/bootstrap.mjs";
import { operatorNormalization } from "../server/operator-normalization.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { PERMISSIONS } from "../src/events.js";

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
  assert.deepEqual(revoked.value, { inviteId: minted.value.inviteId, revoked: true, status: "revoked" });
  const again = await call(origin, "room_revoke_agent_invite", { roomId: room.roomId, inviteId: minted.value.inviteId }, owner.secret);
  assert.equal(again.isError, false, JSON.stringify(again.body));
  assert.deepEqual(again.value, { inviteId: minted.value.inviteId, revoked: true, status: "revoked" });

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

test("a Commons admin can grant admin access on normalized SQLite over MCP", async t => {
  const { origin, store } = await serve(t);
  const roomId = "commons";
  store.initialize(initialRoom(roomId));
  const owner = store.issueAccessKey(roomId, "owner");
  const requesterIdentity = (displayName, permissions) => {
    const identity = store.identities.create(displayName);
    const requestId = displayName.toLowerCase().replaceAll(" ", "-");
    return { ...identity, requestId, displayName, permissions };
  };
  const file = async requester => {
    const response = await fetch(`${origin}/api/access-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${requester.secret}` },
      body: JSON.stringify({ roomId, requestId: requester.requestId, identityId: requester.identityId,
        displayName: requester.displayName, requestedPermissions: [] })
    });
    assert.ok(response.ok, `filing access request returned ${response.status}`);
  };
  const decide = (admin, requester) => call(origin, "room_decide_access_request", {
    roomId, requestId: requester.requestId, decision: "approve", permissions: requester.permissions
  }, admin);
  const invite = store.invites.create(owner, roomId, { ownerEquivalent: true });
  const admin = requesterIdentity("Current Admin", PERMISSIONS);
  store.invites.redeem(invite.code, { identitySecret: admin.secret, displayName: admin.displayName });
  const plan = operatorNormalization(store, { roomId, discardLegacyAssignments: true });
  operatorNormalization(store, { roomId, discardLegacyAssignments: true, planHash: plan.planHash,
    requestId: "adopt-admin-fixture", reason: "Use the Commons serving writer" }, true);

  const peer = requesterIdentity("Requested Admin", PERMISSIONS);
  await file(peer);
  const granted = await decide(admin.secret, peer);
  assert.equal(granted.value?.status, "approved", JSON.stringify(granted.body));
  assert.equal(granted.value.decidedBy, admin.identityId);
  assert.equal(granted.value.memberId, peer.identityId);
  assert.deepEqual(granted.value.grantedPermissions, PERMISSIONS);
  assert.equal(store.roomAuthority(roomId, { memberId: peer.identityId }).members[peer.identityId].delegatedAdmin, true);
  const { ownerId, members } = store.roomAuthority(roomId);
  assert.equal(ownerId, "owner");
  assert.throws(() => store.command(admin.secret, roomId, { id: "attempt-owner-demotion",
    type: "member.access_changed", data: { memberId: ownerId, active: true,
      permissions: ["manage_members"], expectedMemberRevision: members[ownerId].revision } }),
  /Only the Room owner may change owner authority/);

  const scoped = requesterIdentity("Scoped Admin", ["manage_members"]);
  await file(scoped);
  assert.equal((await decide(peer.secret, scoped)).value?.status, "approved");
  const second = requesterIdentity("Second Request", PERMISSIONS);
  await file(second);
  const denied = await decide(scoped.secret, second);
  assert.match(JSON.stringify(denied.body), /Cannot grant permissions not held/);
  const pending = await call(origin, "room_list_access_requests", { roomId }, admin.secret);
  assert.ok(pending.value.requests.some(request => request.requestId === second.requestId));

  const peerMember = store.roomAuthority(roomId, { memberId: peer.identityId }).members[peer.identityId];
  store.command(owner, roomId, { id: "demote-fixture-admin", type: "member.access_changed",
    data: { memberId: peer.identityId, active: true, permissions: [], expectedMemberRevision: peerMember.revision } });
  const afterDemotion = await decide(peer.secret, second);
  assert.match(JSON.stringify(afterDemotion.body), /Membership administration grant required/);

  const demoted = store.roomAuthority(roomId, { memberId: peer.identityId }).members[peer.identityId];
  store.command(admin.secret, roomId, { id: "restore-fixture-admin", type: "member.access_changed",
    data: { memberId: peer.identityId, active: true, permissions: PERMISSIONS, expectedMemberRevision: demoted.revision } });
  assert.equal((await decide(peer.secret, second)).value?.status, "approved");
  assert.doesNotThrow(() => auditRecovery(store));
});

test("minted invite code stays out of the MCP text block and still redeems from structuredContent", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Noor Haddad");
  const room = rooms.create(owner.secret, { roomId: "hygiene-den", title: "Hygiene den", purpose: "Invite text hygiene", kind: "personal", displayName: "Noor Haddad" });

  const minted = await call(origin, "room_create_agent_invite", { roomId: room.roomId, profile: "chat", displayName: "Pia" }, owner.secret);
  assert.equal(minted.isError, false, JSON.stringify(minted.body));
  assert.equal(typeof minted.value.code, "string");
  // The text block is what hosts display and log verbatim (issue #3750):
  // the one-time code may not appear in it — not as the code field, and
  // not inside the next-step descriptions that quote it.
  const text = (minted.body.result.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.ok(text.length > 0, "invite mint must carry a text block");
  assert.equal(text.includes(minted.value.code), false, "invite code must not appear in the text block");
  assert.ok(text.includes("structuredContent.code"), "text must say where the code lives");
  // The machine flow is untouched: the code from structuredContent redeems.
  const guest = store.identities.create("Pia Lind");
  const redeemed = store.invites.redeem(minted.value.code, { displayName: "Pia Lind", identitySecret: guest.secret });
  assert.equal(redeemed.roomId, room.roomId);
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
