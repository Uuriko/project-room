// Presence Gap 4 (BUILD-PRESENCE-GAP4, D2 Charter A): cross-room presence read.
// GET /api/agents/{identityId}/presence answers "where is this one identity
// present, restricted to the rooms the CALLER has standing in" — an active
// member seat, or ownership of record. Contracts pinned here:
//   - the intersection is the privacy boundary: a room the caller cannot
//     stand in contributes no row, and a target sharing no room with the
//     caller is indistinguishable from an unknown identity (same shape);
//   - each room row is the per-room presence row for that member, derived
//     from heartbeat evidence (never a self-declared flag): stop the
//     heartbeats and the row flips offline with lastSeenAt unchanged;
//   - unauthenticated callers are refused; scoped keys need heartbeats:read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { AGENT_PRESENCE_ROUTES } from "../server/routes/agent-presence.mjs";
import { assertRouteRow } from "../server/routes/table.mjs";
import { EVENT_TYPES as T, PERMISSIONS, event, HISTORY_DEFAULTS_VERSION } from "../src/events.js";

test("agent-presence route-table row is well-formed", () => {
  assert.equal(AGENT_PRESENCE_ROUTES.length, 1);
  const [row] = AGENT_PRESENCE_ROUTES;
  assert.deepEqual(assertRouteRow(row), []);
  assert.equal(row.id, "agent-presence");
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/agents/{identityId}/presence");
  assert.equal(typeof row.handler, "function");
});

// ---- HTTP integration (acceptance fixture, real clock) ----

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function makeRoom(origin, fixture, owner, roomId) {
  const res = await post(origin, "/api/agent-rooms", {
    roomId, title: roomId, purpose: "gap4 probe", kind: "personal", displayName: "Owner",
  }, owner.secret);
  assert.equal(res.status, 201);
}

async function joinRoom(origin, owner, joiner, roomId, requestId, displayName) {
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: joiner.identityId, displayName,
    requestedPermissions: ["accept_work"], note: null, requestId,
  }, joiner.secret);
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, owner.secret);
  assert.equal(decideRes.status, 200);
  const { memberId } = await decideRes.json();
  assert.ok(memberId);
  return memberId;
}

// Rooms: gap4-one (caller + target), gap4-two (target + stranger).
// The caller shares exactly one room with the target and none with the stranger.
async function probeFixture(t) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const caller = f.store.identities.create("gap4 caller");
  const target = f.store.identities.create("gap4 target");
  const stranger = f.store.identities.create("gap4 stranger");
  await makeRoom(origin, f, caller, "gap4-one");
  const targetMemberOne = await joinRoom(origin, caller, target, "gap4-one", "gap4-req-t1", "Target");
  const ownerTwo = f.store.identities.create("gap4 owner two");
  await makeRoom(origin, f, ownerTwo, "gap4-two");
  await joinRoom(origin, ownerTwo, target, "gap4-two", "gap4-req-t2", "Target");
  await joinRoom(origin, ownerTwo, stranger, "gap4-two", "gap4-req-s2", "Stranger");
  return { f, origin, caller, target, stranger, targetMemberOne };
}

test("cross-room presence returns exactly the rooms the caller shares with the target", async t => {
  const { origin, caller, target, targetMemberOne } = await probeFixture(t);
  const beat = await post(origin, "/api/agent-heartbeats", { hostId: "gap4-host" }, target.secret);
  assert.equal(beat.status, 200);
  const res = await get(origin, `/api/agents/${target.identityId}/presence`, caller.secret);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.identityId, target.identityId);
  assert.equal(doc.rooms.length, 1, "only the shared room is visible");
  assert.equal(doc.rooms[0].roomId, "gap4-one");
  assert.equal(doc.rooms[0].memberId, targetMemberOne);
  assert.equal(doc.rooms[0].ownerIdentityId, target.identityId);
  assert.equal(doc.rooms[0].presence.status, "online");
});

test("no shared room and unknown identity return the same empty shape", async t => {
  const { origin, caller, stranger } = await probeFixture(t);
  const strangerRes = await get(origin, `/api/agents/${stranger.identityId}/presence`, caller.secret);
  assert.equal(strangerRes.status, 200);
  const strangerDoc = await strangerRes.json();
  assert.deepEqual(strangerDoc.rooms, []);
  const unknownRes = await get(origin, "/api/agents/ai_no_such_identity/presence", caller.secret);
  assert.equal(unknownRes.status, 200);
  const unknownDoc = await unknownRes.json();
  assert.deepEqual(unknownDoc.rooms, []);
  // Nothing beyond the caller-supplied id distinguishes the two answers.
  assert.deepEqual(Object.keys(unknownDoc).sort(), Object.keys(strangerDoc).sort());
});

test("an identity reads its own aggregate across all its rooms", async t => {
  const { origin, target } = await probeFixture(t);
  const res = await get(origin, `/api/agents/${target.identityId}/presence`, target.secret);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.deepEqual(doc.rooms.map(room => room.roomId), ["gap4-one", "gap4-two"]);
});

test("unauthenticated callers are refused and scoped keys need heartbeats:read", async t => {
  const { f, origin, target } = await probeFixture(t);
  assert.equal((await get(origin, `/api/agents/${target.identityId}/presence`)).status, 401);
  const reportOnly = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report"] }, target.secret)).json();
  assert.equal((await get(origin, `/api/agents/${target.identityId}/presence`, reportOnly.credential)).status, 403);
  const reader = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:read"] }, target.secret)).json();
  assert.equal((await get(origin, `/api/agents/${target.identityId}/presence`, reader.credential)).status, 200);
  void f;
});

// ---- Store level (injected clock): derivation honesty + owner standing ----

const T0 = 1_750_000_000_000;

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-gap4-"));
  let at = T0;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => at });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, advance: ms => { at += ms; }, at: () => at };
}

// initialize() creates one room per call from its full event list, so a
// room is built in a single call: ROOM_CREATED + every MEMBER_ADDED,
// then the identity_links rows for the linked members.
function buildRoom(store, roomId, { ownerMemberId, ownerIdentityId, members = [], links = [] }) {
  const at = new Date(T0).toISOString();
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: ownerMemberId, roomId, at,
      data: { roomId, ownerId: ownerMemberId, title: roomId, purpose: "gap4", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
    event({ type: T.MEMBER_ADDED, actorId: ownerMemberId, roomId, at,
      data: { memberId: ownerMemberId, displayName: "Owner", kind: "agent", permissions: [...PERMISSIONS], identityId: ownerIdentityId } }),
    ...members.map(m => event({ type: T.MEMBER_ADDED, actorId: ownerMemberId, roomId, at,
      data: { memberId: m.memberId, displayName: "Member", kind: "agent", permissions: ["accept_work"], identityId: m.identityId } })),
  ]);
  for (const link of links) {
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(roomId, link.identityId, link.memberId, T0);
  }
}

test("host liveness is derived: the row flips offline after the window, lastSeenAt unchanged", t => {
  const { store, advance } = storeFixture(t);
  const caller = store.identities.create("gap4 caller");
  const target = store.identities.create("gap4 target");
  buildRoom(store, "gap4-store-room", {
    ownerMemberId: caller.identityId, ownerIdentityId: caller.identityId,
    members: [{ memberId: "target-member", identityId: target.identityId }],
    links: [
      { identityId: caller.identityId, memberId: caller.identityId },
      { identityId: target.identityId, memberId: "target-member" },
    ],
  });
  store.agentHeartbeats.heartbeat({ agentId: target.identityId, hostId: "h", cadenceSeconds: 60 });
  const callerArg = { identityId: caller.identityId, boundRoomId: null };
  const fresh = store.agentPresence(callerArg, target.identityId);
  assert.equal(fresh.rooms.length, 1);
  assert.equal(fresh.rooms[0].presence.status, "online");
  const seenAt = fresh.rooms[0].presence.lastSeenAt;
  advance(181_000); // past max(180s, 60s x 1.5)
  const stale = store.agentPresence(callerArg, target.identityId);
  assert.equal(stale.rooms.length, 1);
  assert.equal(stale.rooms[0].presence.status, "offline");
  assert.equal(stale.rooms[0].presence.lastSeenAt, seenAt);
});

test("a room owner of record reads identities linked into their room without a member seat", t => {
  const { store } = storeFixture(t);
  const owner = store.identities.create("gap4 owner");
  const caller = store.identities.create("gap4 caller");
  const target = store.identities.create("gap4 target");
  // The owner's member names their identity but holds no identity_links row:
  // standing comes from ownership of record, not from a seat.
  buildRoom(store, "gap4-owned-room", {
    ownerMemberId: "owner-member", ownerIdentityId: owner.identityId,
    members: [{ memberId: "target-member", identityId: target.identityId }],
    links: [{ identityId: target.identityId, memberId: "target-member" }],
  });
  const owned = store.agentPresence({ identityId: owner.identityId, boundRoomId: null }, target.identityId);
  assert.deepEqual(owned.rooms.map(room => room.roomId), ["gap4-owned-room"]);
  const noStanding = store.agentPresence({ identityId: caller.identityId, boundRoomId: null }, target.identityId);
  assert.deepEqual(noStanding.rooms, []);
});
