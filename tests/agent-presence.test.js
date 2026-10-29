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
import { randomUUID } from "node:crypto";
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

// ---- REGISTER row 59 (F-B10-2): truthful presence derivation ----
// The unregistered case is stated instead of dropped to null; workingOn
// derives from live claim state; the summary/next text counts evidence.
// Fixtures are built with initialize() at the injected clock, like
// buildRoom above, with the work/claim events the reducers produce.

function buildPresenceRoom(store, roomId, { ownerIdentity, agentIdentity }) {
  const at = new Date(T0).toISOString();
  const work = (workItemId, title) => [
    event({ type: T.WORK_PROPOSED, actorId: "agent-member", roomId, at,
      data: { workItemId, title, definitionOfDone: "done", accountableMemberId: "agent-member", mode: "write" } }),
    event({ type: T.WORK_ACCEPTED, actorId: "agent-member", roomId, at, data: { workItemId } }),
  ];
  const claim = (workItemId, expiresAt) => event({ type: T.CLAIM_ACQUIRED, actorId: "agent-member", roomId, at,
    data: { workItemId, repository: "repo", ref: "main", paths: ["a.txt"], expiresAt } });
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner-member", roomId, at,
      data: { roomId, ownerId: "owner-member", title: roomId, purpose: "reg59", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner-member", roomId, at,
      data: { memberId: "owner-member", displayName: "Owner", kind: "agent", permissions: [...PERMISSIONS], identityId: ownerIdentity } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner-member", roomId, at,
      data: { memberId: "agent-member", displayName: "Agent", kind: "agent", permissions: [...PERMISSIONS], identityId: agentIdentity } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner-member", roomId, at,
      data: { memberId: "human-member", displayName: "Human", kind: "human", permissions: [] } }),
    ...work("held-one", "Held task"),
    ...work("expired-one", "Expired lease task"),
    ...work("released-one", "Released task"),
    claim("held-one", new Date(T0 + 24 * 3600_000).toISOString()),
    claim("expired-one", new Date(T0 + 3600_000).toISOString()),
    claim("released-one", new Date(T0 + 24 * 3600_000).toISOString()),
    event({ type: T.CLAIM_RELEASED, actorId: "agent-member", roomId, at, data: { workItemId: "released-one" } }),
  ]);
  for (const [identityId, memberId] of [[ownerIdentity, "owner-member"], [agentIdentity, "agent-member"]]) {
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(roomId, identityId, memberId, T0);
  }
}

test("reg59: host-derived presence carries basis host", t => {
  const { store } = storeFixture(t);
  const caller = store.identities.create("reg59 caller");
  const target = store.identities.create("reg59 target");
  buildRoom(store, "reg59-host-room", {
    ownerMemberId: caller.identityId, ownerIdentityId: caller.identityId,
    members: [{ memberId: "target-member", identityId: target.identityId }],
    links: [
      { identityId: caller.identityId, memberId: caller.identityId },
      { identityId: target.identityId, memberId: "target-member" },
    ],
  });
  store.agentHeartbeats.heartbeat({ agentId: target.identityId, hostId: "h", cadenceSeconds: 60 });
  const doc = store.agentPresence({ identityId: caller.identityId, boundRoomId: null }, target.identityId);
  assert.equal(doc.rooms[0].presence.status, "online");
  assert.equal(doc.rooms[0].presence.basis, "host");
});

test("reg59: unregistered basis is member-added until the member commands, then last-command; humans stay null", t => {
  const { store, advance } = storeFixture(t);
  const owner = store.identities.create("reg59 owner");
  const agent = store.identities.create("reg59 agent");
  // Members-only room: the agent is actor of no event, so its only stamp
  // is the join. (The claims fixture below cannot serve here — there the
  // agent proposes/accepts/claims, which are commands.)
  const at = new Date(T0).toISOString();
  store.initialize([
    event({ type: T.ROOM_CREATED, actorId: "owner-member", roomId: "reg59-basis-room", at,
      data: { roomId: "reg59-basis-room", ownerId: "owner-member", title: "reg59-basis-room", purpose: "reg59", kind: "personal", historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner-member", roomId: "reg59-basis-room", at,
      data: { memberId: "owner-member", displayName: "Owner", kind: "agent", permissions: [...PERMISSIONS], identityId: owner.identityId } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner-member", roomId: "reg59-basis-room", at,
      data: { memberId: "agent-member", displayName: "Agent", kind: "agent", permissions: [...PERMISSIONS], identityId: agent.identityId } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner-member", roomId: "reg59-basis-room", at,
      data: { memberId: "human-member", displayName: "Human", kind: "human", permissions: [] } }),
  ]);
  for (const [identityId, memberId] of [[owner.identityId, "owner-member"], [agent.identityId, "agent-member"]]) {
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run("reg59-basis-room", identityId, memberId, T0);
  }
  const rows = () => store.presenceMembers("reg59-basis-room", []);
  const agentRow = () => rows().find(m => m.memberId === "agent-member");
  // Join-only: the join stamp is disclosed by basis, never as a last-seen.
  assert.deepEqual(agentRow().presence, { status: "unregistered", lastSeenAt: null, basis: "member-added" });
  assert.equal(rows().find(m => m.memberId === "human-member").presence, null, "humans have no host concept: presence stays null");
  advance(10 * 60_000);
  const agentKey = store.issueAccessKey("reg59-basis-room", "agent-member");
  store.command(agentKey, "reg59-basis-room", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "first command" } });
  assert.deepEqual(agentRow().presence, { status: "unregistered", lastSeenAt: T0 + 10 * 60_000, basis: "last-command" });
  advance(4 * 60_000);
  // Sentence probe 1: a member wrote 4 minutes ago and holds nothing —
  // the summary counts evidence, asserts neither "online" nor a
  // nobody-claim, and the writer's state stays "idle" (the named
  // accepted residual: state is untouched by this fix).
  const ownerKey = store.issueAccessKey("reg59-basis-room", "owner-member");
  const doc = store.presence(ownerKey, "reg59-basis-room", []);
  const watch = doc.next.find(n => n.action === "watch-presence");
  assert.ok(watch, "nobody is watching/listening/executing, so next keys watch-presence");
  assert.ok(watch.description.includes("1 member with a command in the last 5 minutes"), watch.description);
  assert.ok(!watch.description.includes("online"), watch.description);
  assert.ok(!/nobody/i.test(watch.description), watch.description);
  assert.equal(agentRow().state, "idle");
});

test("reg59: workingOn derives from live claims — held counts, released and lease-expired do not", t => {
  const { store, advance } = storeFixture(t);
  const owner = store.identities.create("reg59 owner");
  const agent = store.identities.create("reg59 agent");
  buildPresenceRoom(store, "reg59-claims-room", { ownerIdentity: owner.identityId, agentIdentity: agent.identityId });
  const agentRow = () => store.presenceMembers("reg59-claims-room", []).find(m => m.memberId === "agent-member");
  // At T0 both live claims show, verbatim board state, no heartbeat key:
  // holding is not executing, so entries carry the claim state, never a
  // session heartbeat, and the row state never becomes "working".
  assert.deepEqual(agentRow().workingOn, [
    { workItemId: "held-one", title: "Held task", status: "claimed" },
    { workItemId: "expired-one", title: "Expired lease task", status: "claimed" },
  ]);
  assert.notEqual(agentRow().state, "working");
  advance(2 * 3600_000);
  assert.deepEqual(agentRow().workingOn, [
    { workItemId: "held-one", title: "Held task", status: "claimed" },
  ], "the 1h lease expired at read time; the released claim never appeared");
  // Sentence probe 2: the claim-holder has been silent for 2 hours. The
  // summary says holding, not working, and holding does not key dm-member.
  const ownerKey = store.issueAccessKey("reg59-claims-room", "owner-member");
  const doc = store.presence(ownerKey, "reg59-claims-room", []);
  assert.ok(!doc.next.some(n => n.action === "dm-member"), "a held claim never keys dm-member");
  const watch = doc.next.find(n => n.action === "watch-presence");
  assert.ok(watch.description.includes("0 live hosts"), watch.description);
  assert.ok(watch.description.includes("0 members with a command in the last 5 minutes"), watch.description);
  assert.ok(watch.description.includes("1 member holding claimed work"), watch.description);
  assert.ok(!watch.description.includes("online"), watch.description);
});
