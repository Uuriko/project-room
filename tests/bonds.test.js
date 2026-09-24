// Agent Bond (Friend) + peer DMs.
// Propose → accept → send/receive → revoke → send refused.
// Scope attenuation, idempotent thread, participant-only receipts.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";
import { peerEventVisible, visibleBonds } from "../server/bonds.mjs";

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
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body)
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {}
});

async function jsonOf(res) {
  const body = await res.json();
  return { status: res.status, body };
}

async function admit(origin, roomId, ownerSecret, identity, label) {
  const requestId = randomUUID();
  const reqRes = await post(origin, "/api/access-requests", {
    roomId, identityId: identity.identityId, displayName: label,
    requestedPermissions: ["accept_work"], note: null, requestId
  });
  assert.equal(reqRes.status, 201, label);
  const decide = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null
  }, ownerSecret);
  assert.equal(decide.status, 200, label);
  return (await decide.json()).memberId;
}

async function roomOf(t) {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("bond owner");
  const friend = fixture.store.identities.create("bond friend");
  const stranger = fixture.store.identities.create("bond stranger");
  const roomId = "bond-room";
  const created = await post(origin, "/api/agent-rooms", {
    roomId, title: "Bonds", purpose: "probe", kind: "personal", displayName: "Owner"
  }, owner.secret);
  assert.equal(created.status, 201);
  await admit(origin, roomId, owner.secret, friend, "Friend");
  await admit(origin, roomId, owner.secret, stranger, "Stranger");
  const command = (secret, type, data) => post(origin, `/api/rooms/${roomId}/commands`, {
    id: randomUUID(), type, data
  }, secret);
  return { origin, roomId, owner, friend, stranger, command, fixture };
}

async function eventsOf(origin, roomId, secret) {
  const res = await get(origin, `/api/rooms/${roomId}/events?limit=100`, secret);
  assert.equal(res.status, 200);
  return (await res.json()).events.map(row => row.event);
}

test("propose, accept, peer DM, revoke, then send is refused", async t => {
  const { origin, roomId, owner, friend, stranger, command } = await roomOf(t);
  const roomChat = await command(owner.secret, "message.posted", {
    messageId: randomUUID(), body: "room chat does not need a bond"
  });
  assert.equal(roomChat.status, 201);

  const early = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "too soon"
  }));
  assert.equal(early.status, 403);
  assert.equal(early.body.error.code, "no_bond");
  assert.match(early.body.error.message, /bond\.propose \{ to \}/);
  assert.doesNotMatch(early.body.error.message, /\{ to, scopes \}/);
  assert.match(early.body.hint, /bond\.propose \{ to \}/);
  assert.doesNotMatch(early.body.hint, /scopes/);
  const proposeStep = early.body.next.find(step => typeof step.command === "string");
  assert.match(proposeStep.command, /bond\.propose \{ to \}/);
  assert.doesNotMatch(proposeStep.command, /scopes/);

  const proposed = await jsonOf(await command(owner.secret, "bond.propose", {
    to: friend.identityId, note: "pair up", scopes: ["peer.wake", "peer.dm", "peer.card"]
  }));
  assert.equal(proposed.status, 201);
  assert.equal(proposed.body.event.type, "bond.proposed");
  const bondId = proposed.body.event.data.bondId;
  assert.deepEqual(proposed.body.event.data.scopes, ["peer.wake", "peer.card", "peer.dm"]);

  const pending = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "still pending"
  }));
  assert.equal(pending.status, 403);
  assert.equal(pending.body.error.code, "bond_pending");
  assert.match(pending.body.hint, /bond\.accept/);

  const selfAccept = await jsonOf(await command(owner.secret, "bond.accept", { bondId }));
  assert.equal(selfAccept.status, 403);
  assert.equal(selfAccept.body.error.code, "bond_not_recipient");

  const inbox = await jsonOf(await get(origin, `/api/rooms/${roomId}/agent-inbox`, friend.secret));
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.bondProposals.length, 1);
  assert.equal(inbox.body.bondProposals[0].bondId, bondId);
  assert.ok(inbox.body.next.some(step => step.action === "accept-bond"));

  const accepted = await jsonOf(await command(friend.secret, "bond.accept", {
    bondId, scopes: ["peer.dm", "peer.context", "peer.handoff"]
  }));
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.event.type, "bond.activated");
  // peer.context was not proposed; peer.handoff is not a v1 scope. Intersection only.
  assert.deepEqual(accepted.body.event.data.acceptedScopes, ["peer.dm"]);

  const first = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "hello friend"
  }));
  const second = await jsonOf(await command(friend.secret, "dm.posted", {
    to: owner.identityId, messageId: randomUUID(), body: "hello back"
  }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.event.type, "dm.posted");
  assert.equal(first.body.event.data.threadId, second.body.event.data.threadId);
  const threadId = first.body.event.data.threadId;

  const threads = await jsonOf(await get(origin, `/api/rooms/${roomId}/peer-dms`, owner.secret));
  assert.equal(threads.body.threads.length, 1);
  assert.equal(threads.body.threads[0].threadId, threadId);
  assert.equal(threads.body.threads[0].untrusted, true);

  const history = await jsonOf(await get(origin, `/api/rooms/${roomId}/peer-dms/${encodeURIComponent(threadId)}`, friend.secret));
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.messages.map(message => message.body), ["hello friend", "hello back"]);
  assert.equal(history.body.messages[0].untrusted, true);
  assert.equal(history.body.untrusted, true);

  const friendInbox = await jsonOf(await get(origin, `/api/rooms/${roomId}/agent-inbox`, friend.secret));
  assert.equal(friendInbox.body.peerMessages.length, 1);
  assert.equal(friendInbox.body.peerMessages[0].body, "hello friend");
  assert.equal(friendInbox.body.peerMessages[0].untrusted, true);
  assert.ok(friendInbox.body.next.some(step => step.action === "reply-peer-dm"));

  const hidden = await jsonOf(await get(origin, `/api/rooms/${roomId}/peer-dms/${encodeURIComponent(threadId)}`, stranger.secret));
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error.code, "thread_not_found");
  const strangerEvents = await eventsOf(origin, roomId, stranger.secret);
  assert.equal(strangerEvents.some(event => event.type === "dm.posted" || event.type.startsWith("bond.")), false);
  const strangerRoom = await jsonOf(await get(origin, `/api/rooms/${roomId}`, stranger.secret));
  assert.equal(strangerRoom.body.state.messages.some(message => message.body === "hello friend"), false);
  assert.equal(strangerRoom.body.state.messages.some(message => message.body === "room chat does not need a bond"), true);
  assert.equal((strangerRoom.body.state.eventLog ?? []).some(event => event.type === "dm.posted"), false);

  const ownerEvents = await eventsOf(origin, roomId, owner.secret);
  assert.equal(ownerEvents.filter(event => event.type === "dm.posted").length, 2);
  assert.equal(ownerEvents.some(event => event.type === "bond.activated"), true);

  const revoked = await jsonOf(await command(owner.secret, "bond.revoke", { bondId }));
  assert.equal(revoked.status, 201);
  assert.equal(revoked.body.event.type, "bond.revoked");
  const after = await jsonOf(await command(friend.secret, "dm.posted", {
    to: owner.identityId, messageId: randomUUID(), body: "after revoke"
  }));
  assert.equal(after.status, 403);
  assert.equal(after.body.error.code, "bond_revoked");
  assert.match(after.body.hint, /bond\.propose/);
  const still = await jsonOf(await get(origin, `/api/rooms/${roomId}/peer-dms/${encodeURIComponent(threadId)}`, owner.secret));
  assert.equal(still.body.messages.length, 2);
});

test("idempotent propose and idempotent peer thread", async t => {
  const { origin, roomId, owner, friend, command } = await roomOf(t);
  const first = await jsonOf(await command(owner.secret, "bond.propose", { to: friend.identityId, scopes: ["peer.dm", "peer.wake"] }));
  const second = await jsonOf(await command(owner.secret, "bond.propose", { to: friend.identityId, scopes: ["peer.card"] }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.bond.id, first.body.event.data.bondId);
  assert.deepEqual(second.body.bond.proposedScopes, ["peer.wake", "peer.dm"]);
  const proposed = (await eventsOf(origin, roomId, owner.secret)).filter(event => event.type === "bond.proposed");
  assert.equal(proposed.length, 1);

  await command(friend.secret, "bond.accept", { bondId: first.body.event.data.bondId, scopes: ["peer.dm"] });
  const a = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "one"
  }));
  const b = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "two"
  }));
  assert.equal(a.body.event.data.threadId, b.body.event.data.threadId);
  const listed = await jsonOf(await get(origin, `/api/rooms/${roomId}/peer-dms`, friend.secret));
  assert.equal(listed.body.threads.length, 1);
});

test("scope attenuation refuses peer.dm when it was not accepted", async t => {
  const { owner, friend, command } = await roomOf(t);
  const proposed = await jsonOf(await command(owner.secret, "bond.propose", {
    to: friend.identityId, scopes: ["peer.card", "peer.wake"]
  }));
  const accepted = await jsonOf(await command(friend.secret, "bond.accept", {
    bondId: proposed.body.event.data.bondId, scopes: ["peer.card", "peer.dm"]
  }));
  assert.deepEqual(accepted.body.event.data.acceptedScopes, ["peer.card"]);
  const denied = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "no dm scope"
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "scope_denied");
  assert.match(denied.body.hint, /peer\.dm/);
});

test("decline ends the proposal and bond.list shows it", async t => {
  const { origin, roomId, owner, friend, command } = await roomOf(t);
  const proposed = await jsonOf(await command(friend.secret, "bond.propose", { to: owner.identityId, scopes: ["peer.dm"] }));
  const bondId = proposed.body.event.data.bondId;
  const declined = await jsonOf(await command(owner.secret, "bond.decline", { bondId }));
  assert.equal(declined.status, 201);
  assert.equal(declined.body.event.type, "bond.revoked");
  assert.equal(declined.body.event.data.reason, "declined");
  const listed = await jsonOf(await get(origin, `/api/rooms/${roomId}/bonds`, friend.secret));
  assert.equal(listed.body.bonds.find(bond => bond.id === bondId).state, "revoked");
  const listedCmd = await jsonOf(await command(friend.secret, "bond.list", {}));
  assert.equal(listedCmd.status, 201);
  assert.equal(listedCmd.body.event, null);
  assert.equal(listedCmd.body.bonds.find(bond => bond.id === bondId).state, "revoked");
  const again = await jsonOf(await command(friend.secret, "dm.posted", {
    to: owner.identityId, messageId: randomUUID(), body: "nope"
  }));
  assert.equal(again.body.error.code, "bond_revoked");
  const reopened = await jsonOf(await command(friend.secret, "bond.propose", { to: owner.identityId }));
  assert.equal(reopened.status, 201);
  assert.deepEqual(reopened.body.event.data.scopes, ["peer.wake", "peer.card", "peer.context", "peer.dm"]);
  assert.notEqual(reopened.body.event.data.bondId, bondId);
});

test("peer DM wakes an offline recipient through agent.wake and does not room-broadcast", async t => {
  const { origin, roomId, owner, friend, stranger, command, fixture } = await roomOf(t);
  let at = Date.now();
  fixture.store.now = () => at;
  const proposed = await jsonOf(await command(owner.secret, "bond.propose", {
    to: friend.identityId, scopes: ["peer.dm"]
  }));
  const bondId = proposed.body.event.data.bondId;
  const pendingInbox = await jsonOf(await get(origin, `/api/rooms/${roomId}/agent-inbox`, friend.secret));
  assert.equal(pendingInbox.body.mentions.length, 0);
  assert.equal(pendingInbox.body.bondProposals.length, 1);
  assert.equal(pendingInbox.body.bondProposals[0].kind, "bond.proposal");
  assert.ok(pendingInbox.body.next.some(step => step.action === "accept-bond"));
  await command(friend.secret, "bond.accept", { bondId, scopes: ["peer.dm"] });

  const beat = await jsonOf(await post(origin, "/api/agent-heartbeats", {
    hostId: "friend-host", mode: "wakeable", wakeUrl: "https://friend.example.test/wake"
  }, friend.secret));
  assert.equal(beat.status, 200);
  const wakeSub = await jsonOf(await post(origin, "/api/agent-webhooks", {
    url: "https://friend.example.test/hooks", events: ["agent.wake"]
  }, friend.secret));
  assert.equal(wakeSub.status, 201);
  const roomSub = await jsonOf(await post(origin, "/api/agent-webhooks", {
    url: "https://stranger.example.test/hooks", events: ["*"]
  }, stranger.secret));
  assert.equal(roomSub.status, 201);

  const messageId = randomUUID();
  const online = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId, body: "you are here"
  }));
  assert.equal(online.status, 201);
  assert.deepEqual(fixture.store.agentHeartbeats.pendingWakes(friend.identityId), []);

  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  const offlineId = randomUUID();
  const offline = await jsonOf(await command(owner.secret, "dm.posted", {
    to: friend.identityId, messageId: offlineId, body: "you stepped away"
  }));
  assert.equal(offline.status, 201);
  const wakes = fixture.store.agentHeartbeats.pendingWakes(friend.identityId);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].kind, "dm");
  assert.equal(wakes[0].messageId, offlineId);

  const journal = await jsonOf(await get(origin,
    `/api/agent-webhooks/${wakeSub.body.subscriptionId}/deliveries`, friend.secret));
  const wakeDeliveries = journal.body.deliveries.filter(row => row.eventType === "agent.wake");
  // deliverWakePing journals the subscription URL and the host wakeUrl.
  // Both are agent.wake. Neither is a room broadcast of dm.posted.
  assert.equal(wakeDeliveries.length, 2);
  assert.ok(wakeDeliveries.every(row => row.state === "pending"));

  const broadcast = await jsonOf(await get(origin,
    `/api/agent-webhooks/${roomSub.body.subscriptionId}/deliveries`, stranger.secret));
  assert.equal(broadcast.body.deliveries.some(row => row.eventType === "dm.posted" || String(row.eventType).startsWith("bond.")), false);
});

test("M1: a member id colliding with a party identity id sees no peer DMs or bonds", async t => {
  // Regression test for the DM-confidentiality leak: peerEventVisible and
  // visibleBonds used to match the room-local memberId against party identity
  // ids. These two predicates are exactly what the room feed (/events), the
  // full snapshot (state.bonds / eventLog tail), the store events filter and
  // the return-brief history consume, so pinning them pins those paths.
  const dm = {
    type: "dm.posted",
    data: {
      messageId: "m-collide", threadId: "dm:ai_a:ai_b", bondId: "bond-1",
      body: "super secret dm body",
      fromIdentityId: "ai_a", toIdentityId: "ai_b"
    }
  };
  const activated = { type: "bond.activated", data: { bondId: "bond-1", agentAId: "ai_a", agentBId: "ai_b" } };
  const bonds = { "bond-1": { agentAId: "ai_a", agentBId: "ai_b", state: "active" } };
  // Attacker: room member whose member id string equals a party's identity id,
  // no linked identity, not the owner.
  const colliding = { memberId: "ai_a", identityId: null, isOwner: false };
  assert.equal(peerEventVisible(dm, colliding), false);
  assert.equal(peerEventVisible(activated, colliding), false);
  assert.deepEqual(visibleBonds(bonds, colliding), {});
  // A genuine party still sees everything through the resolved identity id,
  // even when their member id is unrelated.
  const party = { memberId: "some-unrelated-member", identityId: "ai_b", isOwner: false };
  assert.equal(peerEventVisible(dm, party), true);
  assert.equal(peerEventVisible(activated, party), true);
  assert.deepEqual(Object.keys(visibleBonds(bonds, party)), ["bond-1"]);
  // The room owner still sees bond receipts but never dm.posted bodies.
  const owner = { memberId: "owner-member", identityId: "owner-ident", isOwner: true };
  assert.equal(peerEventVisible(dm, owner), false);
  assert.equal(peerEventVisible(activated, owner), true);
  assert.deepEqual(Object.keys(visibleBonds(bonds, owner)), ["bond-1"]);
  // A plain non-party member sees nothing.
  const stranger = { memberId: "stranger", identityId: "stranger-ident", isOwner: false };
  assert.equal(peerEventVisible(dm, stranger), false);
  assert.deepEqual(visibleBonds(bonds, stranger), {});
});

test("M2: a room owner cannot revoke a bond formed in another room", async t => {
  const fixture = createAcceptanceFixture();
  const origin = await startServer(t, fixture);
  const owner = fixture.store.identities.create("m2 owner");
  const a = fixture.store.identities.create("m2 a");
  const b = fixture.store.identities.create("m2 b");
  for (const roomId of ["m2-room-x", "m2-room-y"]) {
    const created = await post(origin, "/api/agent-rooms", {
      roomId, title: "M2", purpose: "probe", kind: "personal", displayName: "Owner"
    }, owner.secret);
    assert.equal(created.status, 201, roomId);
  }
  // Agent a joins BOTH rooms, so a has an identity_links row in room-x.
  await admit(origin, "m2-room-x", owner.secret, a, "A");
  await admit(origin, "m2-room-y", owner.secret, a, "A");
  await admit(origin, "m2-room-y", owner.secret, b, "B");
  const cmdX = (secret, type, data) => post(origin, "/api/rooms/m2-room-x/commands",
    { id: randomUUID(), type, data }, secret);
  const cmdY = (secret, type, data) => post(origin, "/api/rooms/m2-room-y/commands",
    { id: randomUUID(), type, data }, secret);
  const proposed = await jsonOf(await cmdY(a.secret, "bond.propose", { to: b.identityId, scopes: ["peer.dm"] }));
  assert.equal(proposed.status, 201);
  const bondId = proposed.body.event.data.bondId;
  const accepted = await jsonOf(await cmdY(b.secret, "bond.accept", { bondId, scopes: ["peer.dm"] }));
  assert.equal(accepted.status, 201);
  // Owner of room-x must NOT be able to revoke a bond formed in room-y, even
  // though party a has an identity link in room-x (the old fallback).
  const cross = await jsonOf(await cmdX(owner.secret, "bond.revoke", { bondId }));
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error.code, "bond_not_found");
  // The bond is untouched: a can still DM b in room-y.
  const still = await jsonOf(await cmdY(a.secret, "dm.posted", {
    to: b.identityId, messageId: randomUUID(), body: "still bonded"
  }));
  assert.equal(still.status, 201);
  // Owner of the forming room (room_hint) can still revoke.
  const home = await jsonOf(await cmdY(owner.secret, "bond.revoke", { bondId }));
  assert.equal(home.status, 201);
  assert.equal(home.body.event.type, "bond.revoked");
});
