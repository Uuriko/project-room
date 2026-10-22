// DECLARE (MIG-PRESENCE Gap 1 + Gap 2): availability and execution-capability
// declarations for agent seats.
//
// A seat declares availability (available|busy|away|offline, optional until +
// note) and execution capabilities (execute|review|observe, optional scope)
// on the heartbeat payload. The declarations are identity-level, sticky
// across bare heartbeats, cleared by an explicit null, and surface next to —
// never instead of — heartbeat-derived presence. POST
// /api/rooms/{roomId}/route-request routes a work action to a seat: a seat
// whose declaration excludes the action (or who never declared) answers with
// a typed decline receipt instead of a silent drop.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const heartbeat = (origin, secret, body) => post(origin, "/api/agent-heartbeats", body, secret);

async function addAgentMember(origin, fixture, ownerSecret, roomId, name, requestId) {
  const identity = fixture.store.identities.create(name);
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: identity.identityId, displayName: name,
    requestedPermissions: ["accept_work"], note: null, requestId,
  }, identity.secret);
  assert.equal(reqRes.status, 201);
  const decideRes = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null,
  }, ownerSecret);
  assert.equal(decideRes.status, 200);
  const memberId = (await decideRes.json()).memberId;
  assert.ok(memberId);
  return { ...identity, memberId };
}

async function roomWithAgents(origin, fixture) {
  const owner = fixture.store.identities.create("declare owner");
  const roomId = "declare-room";
  const roomRes = await post(origin, "/api/agent-rooms", {
    roomId, title: "Declare", purpose: "probe", kind: "personal", displayName: "Olivia Owner",
  }, owner.secret);
  assert.equal(roomRes.status, 201);
  const friend = await addAgentMember(origin, fixture, owner.secret, roomId, "Fred Friend", "declare-req-1");
  return { owner, friend, roomId };
}

test("declared availability + execution surface on presence beside heartbeat presence", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { owner, friend, roomId } = await roomWithAgents(origin, fixture);
  const hb = await heartbeat(origin, friend.secret, {
    hostId: "friend-host",
    availability: { state: "away", note: "on a break" },
    execution: { capabilities: ["review"], scope: "docs only" },
  });
  assert.equal(hb.status, 200);
  const res = await get(origin, `/api/rooms/${roomId}/presence`, owner.secret);
  assert.equal(res.status, 200);
  const row = (await res.json()).members.find(m => m.memberId === friend.memberId);
  assert.ok(row, "friend row is listed");
  // Heartbeat presence still says the host is live; the declaration is a
  // separate fact riding next to it, not overwriting it.
  assert.equal(row.presence?.status, "online");
  assert.equal(row.availability?.state, "away");
  assert.equal(row.availability?.note, "on a break");
  assert.deepEqual(row.execution?.capabilities, ["review"]);
  assert.equal(row.execution?.scope, "docs only");
});

test("heartbeat POST echoes the declaration and GET reads it back", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friend } = await roomWithAgents(origin, fixture);
  const hb = await heartbeat(origin, friend.secret, {
    hostId: "friend-host",
    availability: { state: "busy", until: 1893456000000 },
    execution: { capabilities: ["execute", "review"] },
  });
  assert.equal(hb.status, 200);
  const posted = await hb.json();
  assert.equal(posted.declaration?.availability?.state, "busy");
  assert.equal(posted.declaration?.availability?.until, 1893456000000);
  assert.deepEqual(posted.declaration?.execution?.capabilities, ["execute", "review"]);
  const read = await get(origin, "/api/agent-heartbeats", friend.secret);
  assert.equal(read.status, 200);
  const status = await read.json();
  assert.equal(status.availability?.state, "busy");
  assert.deepEqual(status.execution?.capabilities, ["execute", "review"]);
});

test("declarations are sticky across bare heartbeats and clear on explicit null", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friend } = await roomWithAgents(origin, fixture);
  await heartbeat(origin, friend.secret, {
    hostId: "friend-host",
    availability: { state: "away" },
    execution: { capabilities: ["observe"] },
  });
  const bare = await heartbeat(origin, friend.secret, { hostId: "friend-host" });
  assert.equal(bare.status, 200);
  assert.equal((await bare.json()).declaration?.availability?.state, "away");
  const cleared = await heartbeat(origin, friend.secret, { hostId: "friend-host", availability: null });
  assert.equal(cleared.status, 200);
  const clearedJson = await cleared.json();
  assert.equal(clearedJson.declaration?.availability, null);
  assert.deepEqual(clearedJson.declaration?.execution?.capabilities, ["observe"]);
});

test("invalid declarations refuse 422 invalid_heartbeat and store nothing", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friend } = await roomWithAgents(origin, fixture);
  for (const body of [
    { hostId: "friend-host", availability: { state: "sleeping" } },
    { hostId: "friend-host", availability: { state: "away", note: "x".repeat(141) } },
    { hostId: "friend-host", execution: { capabilities: ["fly"] } },
    { hostId: "friend-host", execution: { capabilities: "execute" } },
    { hostId: "friend-host", execution: { scope: "no capabilities" } },
  ]) {
    const res = await heartbeat(origin, friend.secret, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal((await res.json()).error?.code, "invalid_heartbeat");
  }
  const read = await get(origin, "/api/agent-heartbeats", friend.secret);
  const status = await read.json();
  assert.equal(status.availability, null);
  assert.equal(status.execution, null);
});

test("route-request to a review-only seat for execute returns the wrong_seat decline naming the declaration", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { owner, friend, roomId } = await roomWithAgents(origin, fixture);
  await heartbeat(origin, friend.secret, {
    hostId: "friend-host", execution: { capabilities: ["review"], scope: "docs only" },
  });
  const res = await post(origin, `/api/rooms/${roomId}/route-request`, {
    memberId: friend.memberId, action: "execute", note: "please run the migration",
  }, owner.secret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.routed, false);
  assert.equal(json.receipt?.kind, "route_decline");
  assert.equal(json.receipt?.reason, "wrong_seat");
  assert.equal(json.receipt?.memberId, friend.memberId);
  assert.equal(json.receipt?.action, "execute");
  assert.deepEqual(json.receipt?.declaredCapabilities, ["review"]);
  assert.equal(json.receipt?.declaredScope, "docs only");
});

test("route-request for a declared action routes and wakes the seat", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { owner, friend, roomId } = await roomWithAgents(origin, fixture);
  await heartbeat(origin, friend.secret, {
    hostId: "friend-host", execution: { capabilities: ["review"] },
  });
  const res = await post(origin, `/api/rooms/${roomId}/route-request`, {
    memberId: friend.memberId, action: "review",
  }, owner.secret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.routed, true);
  assert.equal(json.receipt?.kind, "route_accepted");
  assert.ok(json.receipt?.requestId, "acceptance carries a request id");
  const hb = await heartbeat(origin, friend.secret, { hostId: "friend-host" });
  assert.equal(hb.status, 200);
  const wakes = (await hb.json()).pendingWakes ?? [];
  assert.ok(wakes.some(w => w.kind === "assignment" && w.messageId === json.receipt.requestId),
    "the routed request is in the seat's wake queue under its request id");
});

test("route-request to an undeclared agent declines execution_not_declared; unknown member 404s", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { owner, roomId } = await roomWithAgents(origin, fixture);
  const second = await addAgentMember(origin, fixture, owner.secret, roomId, "Quinn Quiet", "declare-req-2");
  await heartbeat(origin, second.secret, { hostId: "quiet-host" });
  const res = await post(origin, `/api/rooms/${roomId}/route-request`, {
    memberId: second.memberId, action: "execute",
  }, owner.secret);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.routed, false);
  assert.equal(json.receipt?.reason, "execution_not_declared");
  assert.equal(json.receipt?.declaredCapabilities, null);
  const missing = await post(origin, `/api/rooms/${roomId}/route-request`, {
    memberId: "member-that-does-not-exist", action: "execute",
  }, owner.secret);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error?.code, "member_not_found");
});

test("presenceForCard projects only the availability state", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const { friend } = await roomWithAgents(origin, fixture);
  await heartbeat(origin, friend.secret, {
    hostId: "friend-host",
    availability: { state: "away", note: "do not project the note" },
    execution: { capabilities: ["execute"] },
  });
  fixture.store.db.prepare(`INSERT INTO agent_directory_cards
    (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn)
    VALUES (?, '{}', 'public', ?, 0, 0, 0)`).run("card-declare-1", friend.identityId);
  const presence = fixture.store.agentPlugin.presenceForCard("card-declare-1");
  assert.ok(presence, "card presence resolves");
  assert.equal(presence.status, "online");
  assert.equal(presence.availability, "away");
});
