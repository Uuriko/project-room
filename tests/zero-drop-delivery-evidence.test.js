// Pre-deploy evidence for #6142 (no-bond DMs inside a room) and #6147 (re-wake
// of an unacknowledged mention), exercised through the REAL wake fabric
// (agentHeartbeats), not stubs: durable signals, coalescing, duplicate
// suppression, and offline recovery. Production verification is separate and
// waits for the deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";
import { createRoomServer } from "../server/http.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

function setup(t) {
  const f = createAcceptanceFixture(), clock = createTestClock(f.store.now());
  f.store.now = clock.now;
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const session = f.store.createSession(f.keys.owner), token = randomBytes(32).toString("base64url");
  f.store.agentConnections.apply(session.token, "commons", { action: "create", requestId: "zd-enroll", memberId: "zd-agent", displayName: "Scout", access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, session.session.sessionBinding);
  setTier(f.store.db, "commons", "zd-agent", "t2_standard", { updatedBy: "owner", nowMs: f.store.now() });
  const identity = f.store.identities.create("Scout");
  f.store.db.prepare("INSERT INTO identity_links (room_id,identity_id,member_id,linked_at) VALUES('commons',?,?,?)")
    .run(identity.identityId, "zd-agent", clock.now());
  // A registered host: the only precondition for a durable wake signal.
  f.store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: "scout-host", mode: "wakeable", wakeUrl: "https://scout.example.test/wake" });
  return { f, token, clock, identityId: identity.identityId };
}
const say = (f, key, data) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted", data });
const eventIdOf = (f, messageId) => f.store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND json_extract(body,'$.data.messageId')=?").get(messageId).id;
const setDeadline = (f, messageId, at) => f.store.db.prepare("UPDATE mention_states SET timeout_at=? WHERE room_id='commons' AND message_event_id=?").run(at, eventIdOf(f, messageId));
const mentionWakes = (f, identityId) => f.store.agentHeartbeats.pendingWakes(identityId).filter(row => row.kind === "mention");

test("#6147 real fabric: the first signal is acked, the mention is not; the deadline emits exactly one distinct re-wake", t => {
  const { f, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "ask-1", body: "@Scout please take this" });
  const first = mentionWakes(f, identityId);
  assert.equal(first.length, 1, "original wake is durable");
  // The listener drains its queue (acks the signal) but never acknowledges the mention itself.
  f.store.agentHeartbeats.ackWakes({ agentId: identityId, signalIds: first.map(row => row.signalId) });
  assert.equal(mentionWakes(f, identityId).length, 0);

  setDeadline(f, "ask-1", clock.now() + 1000);
  f.store.flipExpiredMentions("commons");
  assert.equal(mentionWakes(f, identityId).length, 0, "nothing before the deadline");
  clock.advance(1001);
  f.store.flipExpiredMentions("commons");
  const rewoken = mentionWakes(f, identityId);
  assert.equal(rewoken.length, 1, "one re-wake despite the acked first signal");
  assert.equal(rewoken[0].messageId, `rewake:${eventIdOf(f, "ask-1")}`);
  assert.notEqual(rewoken[0].signalId, first[0].signalId);

  // Duplicate suppression: repeated sweeps, reads and a late ack never add a second one.
  for (let i = 0; i < 5; i++) f.store.flipExpiredMentions("commons");
  assert.equal(mentionWakes(f, identityId).length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM agent_wake_signals WHERE agent_id=? AND message_id LIKE 'rewake:%'").get(identityId).n, 1);
});

test("#6147 real fabric: an agent that is offline at the deadline still gets the re-wake when it returns", t => {
  const { f, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "ask-2", body: "@Scout are you there?" });
  setDeadline(f, "ask-2", clock.now() + 1000);
  clock.advance(HEARTBEAT_STALE_AFTER_MS + 5000); // host heartbeat is long stale
  f.store.flipExpiredMentions("commons");
  const queued = mentionWakes(f, identityId);
  assert.deepEqual(queued.map(row => row.messageId).filter(id => id.startsWith("rewake:")), [`rewake:${eventIdOf(f, "ask-2")}`]);
  // original + re-wake both persisted for the offline host
  assert.equal(queued.length, 2);
  // Host returns: its next heartbeat sees both and one ack drains them.
  f.store.agentHeartbeats.heartbeat({ agentId: identityId, hostId: "scout-host", mode: "wakeable", wakeUrl: "https://scout.example.test/wake" });
  assert.equal(mentionWakes(f, identityId).length, 2);
  f.store.agentHeartbeats.ackWakes({ agentId: identityId, signalIds: queued.map(row => row.signalId) });
  assert.equal(mentionWakes(f, identityId).length, 0);
});

test("#6147 real fabric: a read by any member triggers the sweep; an acknowledged mention is never re-woken", t => {
  const { f, token, clock, identityId } = setup(t);
  say(f, f.keys.owner, { messageId: "ask-3", body: "@Scout unseen" });
  say(f, f.keys.owner, { messageId: "ask-4", body: "@Scout seen" });
  f.store.acknowledgeMention(token, "commons", eventIdOf(f, "ask-4"));
  for (const id of ["ask-3", "ask-4"]) setDeadline(f, id, clock.now() + 1000);
  clock.advance(1001);
  // The owner (not the mentioned agent) reads the room: the lazy sweep runs on that read.
  f.store.eventsAfter(f.keys.owner, "commons", 0, 5);
  const rewakes = mentionWakes(f, identityId).filter(row => row.messageId.startsWith("rewake:"));
  assert.deepEqual(rewakes.map(row => row.messageId), [`rewake:${eventIdOf(f, "ask-3")}`]);
});

// ---- #6142: DMs between room co-members need no bond, and still wake ----

const http = (origin, method, path, body, secret) => fetch(`${origin}${path}`, {
  method, headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async res => ({ status: res.status, body: await res.json() }));

async function dmRoom(t) {
  const fixture = createAcceptanceFixture();
  installFakeWebhookDns(fixture.store);
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = fixture.store.identities.create("dm owner"), friend = fixture.store.identities.create("dm friend");
  const roomId = "dm-room";
  assert.equal((await http(origin, "POST", "/api/agent-rooms", { roomId, title: "DMs", purpose: "probe", kind: "personal", displayName: "Owner" }, owner.secret)).status, 201);
  const requestId = randomUUID();
  await http(origin, "POST", "/api/access-requests", { roomId, identityId: friend.identityId, displayName: "Friend", requestedPermissions: ["accept_work"], note: null, requestId }, friend.secret);
  const decided = await http(origin, "POST", `/api/rooms/${roomId}/access-requests/${requestId}/decide`, { decision: "approve", permissions: ["accept_work"], note: null }, owner.secret);
  assert.equal(decided.status, 200);
  setTier(fixture.store.db, roomId, decided.body.memberId, "t2_standard", { updatedBy: "owner", nowMs: fixture.store.now() });
  const dm = (from, to, messageId, body) => http(origin, "POST", `/api/rooms/${roomId}/commands`, { id: randomUUID(), type: "dm.posted", data: { to: to.identityId, messageId, body } }, from.secret);
  return { fixture, origin, roomId, owner, friend, dm };
}

test("#6142 real fabric: a no-bond DM is delivered once, wakes the recipient, survives a duplicate send and an offline host", async t => {
  const { fixture, origin, roomId, owner, friend, dm } = await dmRoom(t);
  let at = Date.now();
  fixture.store.now = () => at;
  const heartbeat = () => fixture.store.agentHeartbeats.heartbeat({ agentId: friend.identityId, hostId: "friend-host", mode: "wakeable", wakeUrl: "https://friend.example.test/wake" });
  heartbeat();
  const bondsBefore = await http(origin, "POST", `/api/rooms/${roomId}/commands`, { id: randomUUID(), type: "bond.list", data: {} }, owner.secret);
  assert.deepEqual(bondsBefore.body.bonds, [], "no bond exists before the first DM");

  const first = randomUUID();
  const sent = await dm(owner, friend, first, "no bond needed");
  assert.equal(sent.status, 201);
  const dmWakes = () => fixture.store.agentHeartbeats.pendingWakes(friend.identityId).filter(row => row.kind === "dm");
  assert.deepEqual(dmWakes().map(row => row.messageId), [first], "recipient has one durable dm wake");

  // Duplicate suppression: the same messageId again never makes a second wake or a second inbox row.
  await dm(owner, friend, first, "no bond needed");
  assert.deepEqual(dmWakes().map(row => row.messageId), [first]);
  const inbox = await http(origin, "GET", `/api/rooms/${roomId}/agent-inbox`, undefined, friend.secret);
  assert.equal(inbox.body.peerMessages.filter(message => message.body === "no bond needed").length, 1);

  // Offline recovery: the host goes stale; the next DM is still queued and both survive until acked.
  at += HEARTBEAT_STALE_AFTER_MS + 1000;
  const second = randomUUID();
  assert.equal((await dm(owner, friend, second, "while you were away")).status, 201);
  assert.deepEqual(dmWakes().map(row => row.messageId), [first, second]);
  heartbeat();
  const queued = dmWakes();
  assert.equal(queued.length, 2, "returning host still sees both");
  fixture.store.agentHeartbeats.ackWakes({ agentId: friend.identityId, signalIds: queued.map(row => row.signalId) });
  assert.equal(dmWakes().length, 0);
  const after = await http(origin, "GET", `/api/rooms/${roomId}/agent-inbox`, undefined, friend.secret);
  assert.equal(after.body.peerMessages.some(message => message.body === "while you were away"), true, "the message itself outlives the wake ack");
});
