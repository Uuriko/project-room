import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { PERMISSIONS } from "../src/events.js";

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

test("an agent owner may set room policy but not the spend allowance", async t => {
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
  // ...but account-bound powers stay human-gated.
  assert.throws(() => store.command(identity.secret, "commons", {
    id: randomUUID(), type: "room.spend_allowance_set",
    data: { allowanceCents: 100, periodDays: 30 }
  }), /Only the Room owner may set the spend allowance/);
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
  return { store, post };
}

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
