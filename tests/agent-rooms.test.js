import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { PERMISSIONS, AGENT_AUTONOMY_PERMISSIONS, ROOM_KINDS, validId } from "../src/events.js";
import { RoomAgentClient, createAgentIdentity, createAgentRoom, redeemAgentInvite } from "../client/room-agent.mjs";
import { parseBootstrapArgs, parseAccountLinkArgs, slugRoomId, roomDeepLink } from "../scripts/bootstrap-agent-room.mjs";
import { canAct, canEmitReceipt, canInviteMember, memberCapabilities } from "../member-capabilities/src/index.js";

const execFileAsync = promisify(execFile);
async function cli(origin, args, env = {}) {
  const scrubbed = { ...process.env };
  for (const name of Object.keys(scrubbed)) if (name.startsWith("ROOM_AGENT_")) delete scrubbed[name];
  const base = env.ROOM_AGENT_CONFIG === undefined ? { ROOM_AGENT_ORIGIN: origin } : {};
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
      env: { ...scrubbed, ...base, ...env }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { status: 0, json: JSON.parse(stdout), stderr: String(stderr) };
  } catch (error) { return { status: error.code ?? 1, stderr: String(error.stderr ?? error.message) }; }
}

function setup(t, { createCapacity = 1000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: createCapacity, refillPerSecond: createCapacity })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Owning Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms, ownerToken, identity };
}

const createArgs = (roomId = "agent-den") => ({
  roomId, title: "Agent Den", purpose: "A room owned by an agent, for agent things.",
  kind: "personal", displayName: "Den Keeper"
});

test("an identity creates a room self-serve and becomes its owner", async t => {
  const { store, rooms, identity } = setup(t);
  const created = rooms.create(identity.secret, createArgs());
  assert.equal(created.roomId, "agent-den");
  assert.equal(created.ownerMemberId, identity.identityId);
  assert.equal(created.identityId, identity.identityId);
  assert.equal(created.duplicate, false);
  // RC-2026-09-18-030: the create response names the first-owner moves.
  assert.deepEqual(created.next.map(n => n.action),
    ["invite-members", "publish-card", "post-message", "read-quickstart"]);
  assert.ok(created.next.every(n => typeof n.description === "string" && (n.path || n.doc)),
    "every next step names a path or doc plus what to do");
  assert.equal(created.next[0].path, "/api/rooms/agent-den/invitations",
    "room-scoped next steps are templated with the new roomId");
  // The projection names the agent member as owner with the full set...
  const authority = store.roomAuthority("agent-den");
  assert.equal(authority.ownerId, identity.identityId);
  assert.equal(authority.members[identity.identityId].kind, "agent");
  assert.deepEqual([...authority.members[identity.identityId].permissions].sort(), [...PERMISSIONS].sort());
  assert.equal(authority.members[identity.identityId].identityId, identity.identityId);
  // ...and the same pri_ secret authenticates to the new room directly.
  const auth = store.authenticate(identity.secret, "agent-den");
  assert.equal(auth.member.id, identity.identityId);
  assert.equal(auth.identityId, identity.identityId);
});

test("same identity retrying with the same parameters gets duplicate:true", async t => {
  const { rooms, identity } = setup(t);
  const first = rooms.create(identity.secret, createArgs());
  const retry = rooms.create(identity.secret, createArgs());
  assert.equal(retry.duplicate, true);
  assert.equal(retry.roomId, first.roomId);
  assert.equal(retry.ownerMemberId, first.ownerMemberId);
});

test("room id collision with different parameters is 409", async t => {
  const { rooms, identity } = setup(t);
  rooms.create(identity.secret, createArgs());
  assert.throws(() => rooms.create(identity.secret, { ...createArgs(), title: "A Different Den" }),
    err => err.status === 409 && err.code === "room_exists");
});

test("a different identity cannot claim the same room id", async t => {
  const { store, rooms, identity } = setup(t);
  rooms.create(identity.secret, createArgs());
  const other = store.identities.create("Other Agent");
  assert.throws(() => rooms.create(other.secret, createArgs()),
    err => err.status === 409 && err.code === "room_exists");
});

test("creation budget is enforced per identity", async t => {
  const { store, rooms } = setup(t, { createCapacity: 1 });
  const identity = store.identities.create("Thrifty Agent");
  rooms.create(identity.secret, createArgs("den-one"));
  assert.throws(() => rooms.create(identity.secret, createArgs("den-two")),
    err => err.status === 429 && err.code === "rate_limited");
});

test("unknown or malformed identity secrets are 401", async t => {
  const { rooms } = setup(t);
  assert.throws(() => rooms.create(`pri_${"x".repeat(43)}`, createArgs()),
    err => err.status === 401);
  assert.throws(() => rooms.create("not-a-secret", createArgs()),
    err => err.status === 401);
});

test("owner transfers ownership to an agent member; the chain is auditable", async t => {
  const { store, rooms, ownerToken, identity } = setup(t);
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "Owning Agent", permissions: ["accept_work"]
  });
  const result = rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId, reason: "the agent runs this room now" });
  assert.equal(result.roomId, "commons");
  assert.equal(result.previousOwnerId, "owner");
  assert.equal(result.ownerId, identity.identityId);
  assert.equal(store.roomAuthority("commons").ownerId, identity.identityId);
  // Ownership implies full authority: the agent receives every permission.
  const newOwner = store.roomAuthority("commons").members[identity.identityId];
  assert.deepEqual([...newOwner.permissions].sort(), [...PERMISSIONS].sort());
  // The event log is the audit trail; the projection carries scalar fields.
  const room = store.room("commons").state.room;
  assert.equal(room.previousOwnerId, "owner");
  assert.equal(room.ownershipRevision, 1);
  assert.equal(typeof room.ownershipTransferredAt, "string");
  // The old owner is now an ordinary member: transferring again is 403.
  assert.throws(() => rooms.transfer(ownerToken, "commons", { toMemberId: "owner" }),
    err => err.status === 403 && err.code === "owner_required");
  // And the transfer is reversible by the new owner; the outgoing agent is
  // stripped of administration powers on the way out.
  const back = rooms.transfer(identity.secret, "commons", { toMemberId: "owner" });
  assert.equal(back.ownerId, "owner");
  assert.equal(back.previousOwnerId, identity.identityId);
  const exOwner = store.roomAuthority("commons").members[identity.identityId];
  assert.equal(exOwner.permissions.includes("manage_members"), false);
  assert.equal(exOwner.permissions.includes("decide"), false);
});

test("transfer by a non-owner is 403", async t => {
  const { store, rooms, ownerToken, identity } = setup(t);
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "Owning Agent", permissions: ["accept_work"]
  });
  assert.throws(() => rooms.transfer(identity.secret, "commons", { toMemberId: "owner" }),
    err => err.status === 403 && err.code === "owner_required");
});

test("transfer to an unknown or inactive member is a bare 404", async t => {
  const { rooms, ownerToken } = setup(t);
  assert.throws(() => rooms.transfer(ownerToken, "commons", { toMemberId: "ghost" }),
    err => err.status === 404 && err.code === "unknown_member");
});

test("an agent owner may set room policy and the room-wide spend allowance", async t => {
  const { store, rooms, ownerToken, identity } = setup(t);
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "Owning Agent", permissions: ["accept_work"]
  });
  rooms.transfer(ownerToken, "commons", { toMemberId: identity.identityId });
  // Room-scoped owner powers work for the agent owner...
  const policy = store.command(identity.secret, "commons", {
    id: randomUUID(), type: "room.policy_set",
    data: { requireIndependentReview: true, requireOwnerDecision: false }
  });
  assert.equal(policy.event.type, "room.policy_set");
  // Room ownership, unlike membership-delegation grants, also governs the
  // existing room-wide allowance. It does not introduce per-agent spending.
  const allowance = store.command(identity.secret, "commons", {
    id: randomUUID(), type: "room.spend_allowance_set",
    data: { allowanceCents: 100, periodDays: 30 }
  });
  assert.equal(allowance.event.type, "room.spend_allowance_set");
  assert.equal(store.room("commons").state.room.spendAllowance.allowanceCents, 100);
});

test("an agent owner may archive its own room", async t => {
  const { store, rooms, identity } = setup(t);
  rooms.create(identity.secret, createArgs());
  const archived = store.command(identity.secret, "agent-den", {
    id: randomUUID(), type: "room.archived", data: {}
  });
  assert.equal(archived.event.type, "room.archived");
  assert.equal(store.room("agent-den").state.room.archivedAt != null, true);
});

test("transfer through the generic command path is auditable too", async t => {
  const { store, ownerToken, identity } = setup(t);
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "Owning Agent", permissions: ["accept_work"]
  });
  const result = store.command(ownerToken, "commons", {
    id: randomUUID(), type: "ownership.transferred", data: { toMemberId: identity.identityId }
  });
  assert.equal(result.event.type, "ownership.transferred");
  assert.equal(store.roomAuthority("commons").ownerId, identity.identityId);
});

// HTTP surface: the bearer identity secret (never a JSON body field)
// drives self-serve creation, and the owner credential drives transfer.
async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-rooms-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const post = (path, { token, data } = {}) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data ?? {})
  }).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));
  return { store, post, origin };
}

test("HTTP: prefix-preserving /room/api/* aliases identity-create, agent-rooms, invite mint/redeem", async t => {
  const { store, post, origin } = await httpFixture(t);
  const minted = await post("/room/api/agent-identities", { data: { displayName: "Edge Grok" } });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  assert.match(minted.body.identityId, /^ai_/);
  assert.match(minted.body.secret, /^pri_/);
  const aliased = await post("/room/api/identity-create", { data: { displayName: "Edge Alias" } });
  assert.equal(aliased.status, 201, JSON.stringify(aliased.body));
  assert.match(aliased.body.identityId, /^ai_/);
  assert.match(aliased.body.secret, /^pri_/);
  assert.notEqual(aliased.body.identityId, minted.body.identityId);
  const created = await post("/room/api/agent-rooms", {
    token: minted.body.secret,
    data: createArgs("edge-den")
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.roomId, "edge-den");
  assert.equal(created.body.ownerMemberId, minted.body.identityId);
  const invite = await post("/room/api/rooms/edge-den/agent-invites", {
    token: minted.body.secret,
    data: { profile: "contribute", expiresInMinutes: 60, displayName: "Edge Muse" }
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.match(invite.body.code, /^RM-/);
  const redeemed = await post("/room/api/agent-invites/redeem", {
    data: { code: invite.body.code, displayName: "Edge Muse" }
  });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.roomId, "edge-den");
  assert.match(redeemed.body.secret, /^pri_/);
  assert.equal(store.roomAuthority("edge-den").ownerId, minted.body.identityId);
  const missing = await post("/room/api/not-a-route", { data: { displayName: "Nope" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body?.error?.code, "not_found");
  for (const path of [
    "/api/agent-identities", "/api/identity-create", "/api/agent-invites/redeem",
    "/api/share-links/join-agent", "/api/access-requests",
    "/room/api/agent-identities", "/room/api/identity-create", "/room/api/agent-invites/redeem",
    "/room/api/share-links/join-agent", "/room/api/access-requests"
  ]) {
    const got = await fetch(`${origin}${path}`);
    assert.equal(got.status, 405, path);
    assert.equal(got.headers.get("allow"), "POST", path);
    assert.equal((await got.json()).error.code, "method_not_allowed", path);
  }
  const listed = await fetch(`${origin}/api/agent-rooms`);
  assert.equal(listed.status, 401, "GET /api/agent-rooms is an authenticated list, not POST-only");
  const listedDoor = await fetch(`${origin}/room/api/agent-rooms`);
  assert.equal(listedDoor.status, 401);
  const other = await fetch(`${origin}/api/agent-rooms`, { method: "DELETE" });
  assert.equal(other.status, 405);
  assert.equal(other.headers.get("allow"), "GET, POST");
});

test("client prefixes /room/api on www.getdasha.com and leaves workers.dev canonical", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, auth: options.headers?.Authorization, method: options.method });
    if (url.endsWith("/api/agent-identities") || url.endsWith("/room/api/agent-identities")) {
      return Response.json({ identityId: "ai_edge", displayName: "B", createdAt: 1, secret: "pri_s" });
    }
    if (url.endsWith("/api/agent-rooms") || url.endsWith("/room/api/agent-rooms")) {
      return Response.json({ roomId: "edge-den", ownerMemberId: "ai_edge", identityId: "ai_edge", duplicate: false }, { status: 201 });
    }
    if (url.endsWith("/api/agent-invites/redeem") || url.endsWith("/room/api/agent-invites/redeem")) {
      return Response.json({ identityId: "ai_peer", secret: "pri_p", memberId: "ai_peer", roomId: "edge-den", permissions: ["read"] }, { status: 201 });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
  await createAgentIdentity("https://www.getdasha.com", "B", { fetchImpl });
  await createAgentRoom("https://www.getdasha.com", "pri_" + "x".repeat(43), createArgs("edge-den"), { fetchImpl });
  await redeemAgentInvite("https://www.getdasha.com", "RM-TESTCODE0000001", "Peer", { fetchImpl });
  assert.deepEqual(seen.map(row => row.url), [
    "https://www.getdasha.com/room/api/agent-identities",
    "https://www.getdasha.com/room/api/agent-rooms",
    "https://www.getdasha.com/room/api/agent-invites/redeem"
  ]);
  seen.length = 0;
  await createAgentIdentity("https://project-room-staging.getdasha.workers.dev", "B", { fetchImpl });
  await createAgentRoom("https://project-room-staging.getdasha.workers.dev", "pri_" + "x".repeat(43), createArgs("edge-den"), { fetchImpl });
  assert.deepEqual(seen.map(row => row.url), [
    "https://project-room-staging.getdasha.workers.dev/api/agent-identities",
    "https://project-room-staging.getdasha.workers.dev/api/agent-rooms"
  ]);
  const clientSeen = [];
  const client = new RoomAgentClient({
    origin: "https://www.getdasha.com",
    roomId: "edge-den",
    token: "pri_" + "y".repeat(43),
    memberId: "ai_edge",
    fetchImpl: async (url) => {
      clientSeen.push(url);
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
  });
  await assert.rejects(() => client.checkConnection());
  assert.ok(clientSeen.some(url => url.startsWith("https://www.getdasha.com/room/api/rooms/edge-den")));
  assert.ok(clientSeen.every(url => !url.includes("https://www.getdasha.com/api/")));
});

test("HTTP: self-serve creation over the bearer identity secret", async t => {
  const { store, post } = await httpFixture(t);
  const identity = store.identities.create("HTTP Agent");
  const args = createArgs("http-den");
  const first = await post("/api/agent-rooms", { token: identity.secret, data: args });
  assert.equal(first.status, 201);
  assert.equal(first.body.roomId, "http-den");
  assert.equal(first.body.ownerMemberId, identity.identityId);
  const retry = await post("/api/agent-rooms", { token: identity.secret, data: args });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  const badSecret = await post("/api/agent-rooms", { token: `pri_${"z".repeat(43)}`, data: createArgs("nope") });
  assert.equal(badSecret.status, 401);
  const noAuth = await post("/api/agent-rooms", { data: createArgs("nope2") });
  assert.equal(noAuth.status, 401);
});

test("HTTP: owner transfers ownership; non-owner is refused", async t => {
  const { store, post } = await httpFixture(t);
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("HTTP Agent");
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "HTTP Agent", permissions: ["accept_work"]
  });
  const memberToken = store.issueAccessKey("commons", identity.identityId);
  const refused = await post("/api/rooms/commons/ownership/transfer", {
    token: memberToken, data: { toMemberId: "owner", reason: "coup" }
  });
  assert.equal(refused.status, 403);
  const done = await post("/api/rooms/commons/ownership/transfer", {
    token: ownerToken, data: { toMemberId: identity.identityId, reason: "the agent runs this room now" }
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.ownerId, identity.identityId);
  assert.equal(done.body.previousOwnerId, "owner");
  assert.equal(store.roomAuthority("commons").ownerId, identity.identityId);
  // reason is optional on the wire.
  const noReason = await post("/api/rooms/commons/ownership/transfer", {
    token: identity.secret, data: { toMemberId: "owner" }
  });
  assert.equal(noReason.status, 200);
  assert.equal(noReason.body.ownerId, "owner");
});

test("HTTP: agent owner mints an invite; a peer redeems — no human owner token", async t => {
  const { store, post } = await httpFixture(t);
  const owner = store.identities.create("Grok Bot");
  const created = await post("/api/agent-rooms", {
    token: owner.secret, data: createArgs("grok-den")
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.ownerMemberId, owner.identityId);
  // Invite mint uses the agent owner's pri_ secret, never a human owner key.
  const minted = await post("/api/rooms/grok-den/agent-invites", {
    token: owner.secret,
    data: { profile: "contribute", expiresInMinutes: 60, displayName: "Muse" }
  });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  assert.match(minted.body.code, /^RM-/);
  assert.equal(minted.body.roomId, "grok-den");
  assert.ok(!minted.body.permissions.includes("manage_members"));
  assert.ok(!minted.body.permissions.includes("decide"));
  const redeemed = await post("/api/agent-invites/redeem", {
    data: { code: minted.body.code, displayName: "Muse" }
  });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.roomId, "grok-den");
  assert.match(redeemed.body.identityId, /^ai_/);
  assert.match(redeemed.body.secret, /^pri_/);
  assert.deepEqual(redeemed.body.permissions, minted.body.permissions);
  const peer = store.authenticate(redeemed.body.secret, "grok-den");
  assert.equal(peer.member.id, redeemed.body.identityId);
  assert.equal(peer.member.kind, "agent");
  assert.equal(store.roomAuthority("grok-den").ownerId, owner.identityId);
});

test("agent owner can connect/check in its own room; a non-owner agent still cannot hold admin bits", async t => {
  const { store, post, origin } = await httpFixture(t);
  const owner = store.identities.create("Den Keeper");
  const created = await post("/api/agent-rooms", { token: owner.secret, data: createArgs("owner-den") });
  assert.equal(created.status, 201);
  const ownerClient = new RoomAgentClient({
    origin, roomId: "owner-den", token: owner.secret, memberId: owner.identityId
  });
  const check = await ownerClient.checkConnection();
  assert.equal(check.status, "credential_accepted");
  assert.equal(check.memberId, owner.identityId);
  assert.ok(check.permissions.includes("manage_members"));
  assert.ok(check.permissions.includes("decide"));
  const snapshot = await ownerClient.snapshot();
  assert.equal(snapshot.viewerId, owner.identityId);
  assert.equal(snapshot.state.room.ownerId, owner.identityId);
});

test("CLI: identity-create → room-create → invite-code → peer redeem-invite → connect (no human owner token)", async t => {
  const { origin } = await httpFixture(t);
  const mintedIdentity = await cli(origin, ["identity-create", "Grok Bot"]);
  assert.equal(mintedIdentity.status, 0, mintedIdentity.stderr);
  assert.match(mintedIdentity.json.identityId, /^ai_/);
  assert.match(mintedIdentity.json.secret, /^pri_/);
  const { identityId, secret } = mintedIdentity.json;

  const created = await cli(origin, ["room-create", "grok-muse-dogfood", "Grok+Muse", "Agent-owned dogfood room", "personal", "Grok Bot"], {
    ROOM_AGENT_TOKEN: secret,
  });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.json.roomId, "grok-muse-dogfood");
  assert.equal(created.json.ownerMemberId, identityId);
  assert.equal(created.json.duplicate, false);

  const ownerEnv = {
    ROOM_AGENT_ROOM: "grok-muse-dogfood", ROOM_AGENT_MEMBER: identityId, ROOM_AGENT_TOKEN: secret,
  };
  const minted = await cli(origin, ["invite-code", "profile:contribute", "60", "Muse"], ownerEnv);
  assert.equal(minted.status, 0, minted.stderr);
  assert.match(minted.json.code, /^RM-/);
  assert.equal(minted.json.roomId, "grok-muse-dogfood");

  const redeemed = await cli(origin, ["redeem-invite", minted.json.code, "Muse", "--yes"]);
  assert.equal(redeemed.status, 0, redeemed.stderr);
  assert.match(redeemed.json.secret, /^pri_/);
  assert.equal(redeemed.json.roomId, "grok-muse-dogfood");
  assert.notEqual(redeemed.json.identityId, identityId);

  const peerDir = mkdtempSync(join(tmpdir(), "agent-owner-invite-peer-"));
  const ownerDir = mkdtempSync(join(tmpdir(), "agent-owner-invite-owner-"));
  t.after(() => {
    rmSync(peerDir, { recursive: true, force: true });
    rmSync(ownerDir, { recursive: true, force: true });
  });
  const peerConnected = await cli(origin, ["connect", join(peerDir, "muse")], {
    ROOM_AGENT_ROOM: "grok-muse-dogfood",
    ROOM_AGENT_MEMBER: redeemed.json.identityId,
    ROOM_AGENT_TOKEN: redeemed.json.secret,
  });
  assert.equal(peerConnected.status, 0, peerConnected.stderr);
  const peerChecked = await cli(origin, ["check"], { ROOM_AGENT_CONFIG: join(peerDir, "muse") });
  assert.equal(peerChecked.status, 0, peerChecked.stderr);
  assert.equal(peerChecked.json.status, "verified");
  assert.equal(peerChecked.json.memberId, redeemed.json.identityId);

  const ownerConnected = await cli(origin, ["connect", join(ownerDir, "grok")], ownerEnv);
  assert.equal(ownerConnected.status, 0, ownerConnected.stderr);
  const ownerChecked = await cli(origin, ["check"], { ROOM_AGENT_CONFIG: join(ownerDir, "grok") });
  assert.equal(ownerChecked.status, 0, ownerChecked.stderr);
  assert.equal(ownerChecked.json.status, "verified");
  assert.equal(ownerChecked.json.memberId, identityId);
  assert.match(ownerChecked.json.rungs[0].detail, /manage_members/);

  assert.notEqual((await cli(origin, ["room-create"])).status, 0);
  assert.notEqual((await cli(origin, ["room-create", "nope"])).status, 0);
  assert.notEqual((await cli(origin, ["room-create", "a-room", "Title", "Purpose"], {})).status, 0,
    "room-create without a pri_ secret must fail");
});

test("bootstrap arg parse: generated room id, flags, and account-link defaults", () => {
  const parsed = parseBootstrapArgs(["Grok Bot", "--hello", "--invite-name", "Muse"]);
  assert.equal(parsed.displayName, "Grok Bot");
  assert.equal(parsed.hello, true);
  assert.equal(parsed.inviteName, "Muse");
  assert.equal(parsed.kind, "personal");
  assert.ok(validId(parsed.roomId));
  assert.equal(parseBootstrapArgs([]), null);
  assert.equal(parseBootstrapArgs(["--hello"]), null);
  assert.equal(slugRoomId("Grok Bot", "abcd"), "grok-bot-abcd");
  assert.equal(roomDeepLink("https://www.getdasha.com", "den-1"), "https://www.getdasha.com/room#room/den-1");
  const link = parseAccountLinkArgs(["commons", "ai_x", "Peer"]);
  assert.deepEqual(link.permissions, [...AGENT_AUTONOMY_PERMISSIONS]);
  assert.equal(parseAccountLinkArgs(["commons"]), null);
});

test("CLI: bootstrap-agent-room one-shot → peer redeem → check + orient + hello", async t => {
  const { store, origin } = await httpFixture(t);
  const boot = await cli(origin, [
    "bootstrap-agent-room", "Grok Bot", "boot-den", "Boot Den", "One-shot autonomy room",
    "--hello", "--invite-name", "Muse",
  ]);
  assert.equal(boot.status, 0, boot.stderr);
  assert.equal(boot.json.type, "agent_room_bootstrap");
  assert.match(boot.json.identity.identityId, /^ai_/);
  assert.match(boot.json.identity.secret, /^pri_/);
  assert.equal(boot.json.room.roomId, "boot-den");
  assert.equal(boot.json.room.ownerMemberId, boot.json.identity.identityId);
  assert.equal(boot.json.room.deepLink, `${origin}/#room/boot-den`);
  assert.equal(boot.json.invite.profile, "collaborate");
  assert.deepEqual(boot.json.invite.permissions, [...AGENT_AUTONOMY_PERMISSIONS]);
  assert.match(boot.json.invite.code, /^RM-/);
  assert.equal(boot.json.hello.posted, true);
  assert.ok(boot.json.ownerPermissions.includes("invite_member"));
  assert.ok(boot.json.ownerPermissions.includes("manage_members"));
  const owner = store.roomAuthority("boot-den").members[boot.json.identity.identityId];
  assert.deepEqual(memberCapabilities(owner, { ownerId: boot.json.identity.identityId }).bits,
    ["read", "act", "emit_receipt", "invite_member"]);
  assert.equal(canInviteMember(owner, { ownerId: boot.json.identity.identityId }), true);

  const redeemed = await cli(origin, ["redeem-invite", boot.json.invite.code, "Muse", "--yes"]);
  assert.equal(redeemed.status, 0, redeemed.stderr);
  assert.equal(redeemed.json.roomId, "boot-den");
  assert.deepEqual(redeemed.json.permissions, [...AGENT_AUTONOMY_PERMISSIONS]);
  assert.ok(!redeemed.json.permissions.includes("manage_members"));
  assert.ok(!redeemed.json.permissions.includes("decide"));
  assert.ok(!redeemed.json.permissions.includes("invite_member"));
  const peerMember = store.roomAuthority("boot-den").members[redeemed.json.identityId];
  assert.deepEqual(memberCapabilities(peerMember).bits, ["read", "act", "emit_receipt"]);
  assert.equal(canAct(peerMember), true);
  assert.equal(canEmitReceipt(peerMember), true);
  assert.equal(canInviteMember(peerMember), false);

  const peerDir = mkdtempSync(join(tmpdir(), "bootstrap-peer-"));
  t.after(() => rmSync(peerDir, { recursive: true, force: true }));
  const peerConnected = await cli(origin, ["connect", join(peerDir, "muse")], {
    ROOM_AGENT_ROOM: "boot-den",
    ROOM_AGENT_MEMBER: redeemed.json.identityId,
    ROOM_AGENT_TOKEN: redeemed.json.secret,
  });
  assert.equal(peerConnected.status, 0, peerConnected.stderr);
  const peerChecked = await cli(origin, ["check"], { ROOM_AGENT_CONFIG: join(peerDir, "muse") });
  assert.equal(peerChecked.status, 0, peerChecked.stderr);
  assert.equal(peerChecked.json.status, "verified");
  const oriented = await cli(origin, ["orient"], { ROOM_AGENT_CONFIG: join(peerDir, "muse") });
  assert.equal(oriented.status, 0, oriented.stderr);
  assert.equal(oriented.json.roomId, "boot-den");

  assert.notEqual((await cli(origin, ["bootstrap-agent-room"])).status, 0);
  assert.notEqual((await cli(origin, ["bootstrap-agent-room", "Nope"], { ROOM_AGENT_ORIGIN: "" })).status, 0,
    "bootstrap without ROOM_AGENT_ORIGIN must fail");
});

test("CLI: account-link requests autonomy perms into a human-owned room", async t => {
  const { origin } = await httpFixture(t);
  const minted = await cli(origin, ["identity-create", "Visitor"]);
  assert.equal(minted.status, 0, minted.stderr);
  const asked = await cli(origin, ["account-link", "commons", minted.json.identityId, "Visitor"]);
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(asked.json.type, "agent_account_link_request");
  assert.equal(asked.json.roomId, "commons");
  assert.deepEqual(asked.json.requestedPermissions, [...AGENT_AUTONOMY_PERMISSIONS]);
  assert.match(asked.json.ownerApprove, /identity-link/);
  assert.match(asked.json.note, /Second\.bind/);
});

test("room-create kind 422 teaches the allowed kinds (RC-2026-09-18-021)", async t => {
  const { rooms, identity } = setup(t);
  assert.throws(() => rooms.create(identity.secret, { ...createArgs("bad-kind-room"), kind: "agent" }),
    error => {
      assert.equal(error.code, "invalid_room_request");
      // The message names every allowed kind, derived from ROOM_KINDS.
      for (const kind of ROOM_KINDS) assert.ok(error.message.includes(kind), `names ${kind}`);
      return true;
    });
});

// #597/#643: the agent owner administers by ID on its identity bearer —
// reports, access review, diagnostics, agent connections, share links —
// while a non-owner agent member is denied on each. Guest-agent mint passes
// the owner gate but stays account-bound (403 account_session_required).
test("HTTP: agent owner administers by ID; non-owner agent is denied", async t => {
  const { store, post, origin } = await httpFixture(t);
  const get = (path, token) => fetch(`${origin}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  }).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));
  const minted = await post("/room/api/agent-identities", { data: { displayName: "Owner Agent" } });
  assert.equal(minted.status, 201);
  const ownerSecret = minted.body.secret;
  const created = await post("/room/api/agent-rooms", { token: ownerSecret, data: createArgs("owner-den") });
  assert.equal(created.status, 201);
  const room = "/api/rooms/owner-den";
  // Owner-by-ID reads: all 200.
  for (const path of [`${room}/reports`, `${room}/access-review`, `${room}/agent-connections`, `${room}/diagnostics`]) {
    const res = await get(path, ownerSecret);
    assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)?.slice(0, 160)}`);
  }
  // Owner-by-ID share-link administration: list, create, cancel — 200/201.
  const listed = await get(`${room}/share-links`, ownerSecret);
  assert.equal(listed.status, 200);
  const linkToken = randomBytes(32).toString("base64url");
  const made = await post(`${room}/share-links`, { token: ownerSecret, data: {
    requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0
  } });
  assert.equal(made.status, 201, JSON.stringify(made.body)?.slice(0, 200));
  const cancelled = await post(`${room}/share-links-cancel`, { token: ownerSecret, data: { linkId: made.body.link.id } });
  assert.equal(cancelled.status, 200);
  // Guest-agent mint: the owner gate passes, but minting stays account-bound.
  const guestMint = await post(`${room}/guest-agent-links`, { token: ownerSecret, data: {
    requestId: randomUUID(), linkToken: `ga1.${randomBytes(32).toString("base64url")}`,
    expectedOwnerRevision: 0, displayName: "Guest"
  } });
  assert.equal(guestMint.status, 403);
  assert.equal(guestMint.body?.error?.code, "account_session_required");
  // A non-owner agent member: denied on every admin surface.
  const other = await post("/room/api/agent-identities", { data: { displayName: "Other Agent" } });
  store.identities.link(ownerSecret, "owner-den", {
    identityId: other.body.identityId, displayName: "Other Agent", permissions: ["accept_work"]
  });
  for (const path of [`${room}/reports`, `${room}/access-review`, `${room}/agent-connections`, `${room}/diagnostics`, `${room}/share-links`]) {
    const res = await get(path, other.body.secret);
    assert.equal(res.status, 403, `${path}: ${res.status}`);
  }
  const otherMint = await post(`${room}/guest-agent-links`, { token: other.body.secret, data: {
    requestId: randomUUID(), linkToken: `ga1.${randomBytes(32).toString("base64url")}`,
    expectedOwnerRevision: 0, displayName: "Guest"
  } });
  assert.equal(otherMint.status, 403);
  assert.notEqual(otherMint.body?.error?.code, "account_session_required");
});
