// RC-2026-09-24-210 — peer-DM message bodies are room-scoped.
// A linked identity acts through the link of the room that granted it,
// so the DM surface must not let room B's lens read room A's DM traffic:
// readThread and the agent-inbox peer messages return only bodies posted
// in the requesting room. Thread/bond metadata (who you bonded with)
// stays identity-visible; bodies never cross rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function storeFixture(t) {
  let now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const a = store.identities.create("Peer A"), b = store.identities.create("Peer B");
  const link = (roomId, identityId, memberId) => store.db
    .prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
    .run(roomId, identityId, memberId, now);
  const threadId = "thread-scope-1";
  store.db.prepare("INSERT INTO peer_dm_threads(thread_id, bond_id, agent_a, agent_b, created_at) VALUES(?,?,?,?,?)")
    .run(threadId, "bond-scope-1", a.identityId, b.identityId, now);
  const message = (roomId, body) => store.db
    .prepare("INSERT INTO peer_dm_messages(message_id, thread_id, room_id, event_id, from_identity_id, to_identity_id, body, created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), threadId, roomId, randomUUID(), a.identityId, b.identityId, body, now);
  return { store, ownerKey, a, b, link, threadId, message, now: () => now };
}

test("readThread returns only messages posted in the requesting room", t => {
  const f = storeFixture(t);
  f.link("commons", f.a.identityId, "agent-a");
  f.message("commons", "hello from commons");
  f.message("other-room", "hello from the other room");
  const inCommons = f.store.bonds.readThread("commons", "agent-a", f.threadId);
  assert.deepEqual(inCommons.messages.map(m => m.body), ["hello from commons"]);
  assert.equal(inCommons.threadId, f.threadId, "thread metadata still resolves");
});

test("recentMessagesFor is room-scoped: the inbox never shows another room's DMs", t => {
  const f = storeFixture(t);
  f.link("commons", f.b.identityId, "agent-b");
  f.message("commons", "commons-only body");
  f.message("other-room", "other-room body");
  const commons = f.store.bonds.recentMessagesFor(f.b.identityId, "commons", 10);
  assert.deepEqual(commons.map(m => m.body), ["commons-only body"]);
  const other = f.store.bonds.recentMessagesFor(f.b.identityId, "other-room", 10);
  assert.deepEqual(other.map(m => m.body), ["other-room body"]);
  assert.equal(f.store.bonds.recentMessagesFor(f.b.identityId, "never", 10).length, 0);
});

test("listThreads still returns global thread metadata (no bodies)", t => {
  const f = storeFixture(t);
  f.link("commons", f.a.identityId, "agent-a");
  f.message("other-room", "hidden body");
  const threads = f.store.bonds.listThreads("commons", "agent-a");
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadId, f.threadId);
  assert.equal(threads[0].peerIdentityId, f.b.identityId);
  assert(!JSON.stringify(threads).includes("hidden body"), "metadata carries no message bodies");
});

test("agentInbox peerMessages are scoped to the requesting room", t => {
  const f = storeFixture(t);
  // Enroll a real agent member, then attach the identity link to it.
  const ownerSession = f.store.createSession(f.ownerKey);
  const token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(ownerSession.token, "commons", { action: "create", requestId: randomUUID(), memberId: "agent-b",
    displayName: "Peer B", access: "chat", keyHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: f.now() + 3600000, expectedOwnerRevision: 0 }, ownerSession.session.sessionBinding);
  f.link("commons", f.b.identityId, "agent-b");
  f.message("commons", "commons body");
  f.message("other-room", "other-room body");
  const inbox = f.store.agentInbox(token, "commons", { limit: 10 });
  const bodies = (inbox.peerMessages ?? []).map(m => m.body);
  assert(bodies.includes("commons body"), "own room's DM is visible");
  assert(!bodies.includes("other-room body"), "another room's DM is not visible");
});

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
const jsonOf = async res => ({ status: res.status, body: await res.json() });

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

test("end-to-end: a DM posted in room A is invisible when the thread is read in room B", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const owner = f.store.identities.create("scope owner");
  const friend = f.store.identities.create("scope friend");
  for (const roomId of ["scope-room-a", "scope-room-b"]) {
    const created = await post(origin, "/api/agent-rooms", {
      roomId, title: `Scope ${roomId}`, purpose: "probe", kind: "personal", displayName: "Owner"
    }, owner.secret);
    assert.equal(created.status, 201, roomId);
    const memberId = await admit(origin, roomId, owner.secret, friend, "Friend");
    // #953: access-request admission defaults to t1_readonly; friend needs write access for bond.accept
    setTier(f.store.db, roomId, memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  const command = (roomId, secret, type, data) => post(origin, `/api/rooms/${roomId}/commands`, { id: randomUUID(), type, data }, secret);

  // Bond once (room A); the bond is identity-level, the DMs are room-scoped.
  const proposed = await jsonOf(await command("scope-room-a", owner.secret, "bond.propose", {
    to: friend.identityId, scopes: ["peer.dm"], note: "scope probe"
  }));
  assert.equal(proposed.status, 201);
  const accepted = await jsonOf(await command("scope-room-a", friend.secret, "bond.accept", {
    bondId: proposed.body.event.data.bondId, scopes: ["peer.dm"]
  }));
  assert.equal(accepted.status, 201);

  const first = await jsonOf(await command("scope-room-a", owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "room A secret"
  }));
  assert.equal(first.status, 201);
  const threadId = first.body.event.data.threadId;
  const second = await jsonOf(await command("scope-room-b", owner.secret, "dm.posted", {
    to: friend.identityId, messageId: randomUUID(), body: "room B note"
  }));
  assert.equal(second.status, 201);

  const inA = await jsonOf(await get(origin, `/api/rooms/scope-room-a/peer-dms/${encodeURIComponent(threadId)}`, friend.secret));
  assert.equal(inA.status, 200);
  assert.deepEqual(inA.body.messages.map(m => m.body), ["room A secret"]);
  const inB = await jsonOf(await get(origin, `/api/rooms/scope-room-b/peer-dms/${encodeURIComponent(threadId)}`, friend.secret));
  assert.equal(inB.status, 200);
  assert.deepEqual(inB.body.messages.map(m => m.body), ["room B note"],
    "reading the same thread in room B shows only room B's bodies");
});
