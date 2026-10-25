// Guest-aware wake resolution (decision #25; #3764 + #3777): the three
// wake legs — mention fan-out, reaction ack, webhook fan-out — resolve
// members through one shared resolver (identity_links first, guest_members
// fallback), so a trial seat's mention wake, reaction ack, and webhook
// deliveries all resolve the same identity. Before this fix the legs had
// drifted: only the mention fan-out had the guest fallback, so a guest's
// reaction ack silently no-oped (the wake re-fired on every poll — the
// phantom re-wake loop) and a guest's webhook subscriptions silently
// received no room-event deliveries at all.
//
// Boundary (decision #25): the work-wake resolver (identityIdForMember)
// is deliberately NOT guest-aware — trial seats still get no work wakes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { identityIdForWakeMember, memberIdForWakeIdentity } from "../server/wake-identity-resolution.mjs";

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
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});

// Seat a trial-seat (guest) agent through the real mint -> redeem flow.
// The member lands in guest_members only — never identity_links.
async function seatGuest(f, origin, ownerKey, name) {
  const mint = await (await post(origin, "/api/rooms/commons/guest-invites",
    { requestId: randomUUID(), guestLabel: `guest ${name}`, expectedOwnerRevision: 0, credentialTtlMs: 3600_000 },
    ownerKey)).json();
  assert.ok(mint.code, `mint returns a code: ${JSON.stringify(mint).slice(0, 200)}`);
  const identity = f.store.identities.create(name);
  const kp = generateKeyPair();
  const cardBody = { name, description: "guest wake resolution test", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: kp.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: kp.privateKey }) };
  const redeemed = await (await post(origin, "/api/guest-invites/redeem",
    { inviteCode: mint.code, card }, identity.secret)).json();
  assert.ok(redeemed.member?.id, `redeem seats a member: ${JSON.stringify(redeemed).slice(0, 200)}`);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM identity_links WHERE room_id=? AND member_id=?")
    .get("commons", redeemed.member.id).n, 0, "trial seat has no identity_links row");
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM guest_members WHERE room_id=? AND member_id=?")
    .get("commons", redeemed.member.id).n, 1, "trial seat lives in guest_members");
  return { identity, memberId: redeemed.member.id, token: redeemed.token };
}


test("a trial seat's webhook subscription receives room events; the DM fence binds the guest seat (#3777)", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guest = await seatGuest(f, origin, ownerKey, "GuestHook");

  // Control: a linked member identity in the same room.
  const linked = f.store.identities.create("hook-linked");
  f.store.identities.link(ownerKey, "commons", {
    identityId: linked.identityId, memberId: "hook-linked", displayName: "HookLinked", permissions: [],
  });
  // Non-member control: an identity seated in neither table.
  const stranger = f.store.identities.create("hook-stranger");

  for (const [identity, label] of [[guest.identity, "guest"], [linked, "linked"], [stranger, "stranger"]]) {
    f.store.agentPlugin.subscribeWebhook({
      identityId: identity.identityId, url: `https://${label}.example.test/hook`, events: ["message.posted"],
    });
  }
  const deliveriesFor = identityId => f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_webhook_deliveries WHERE agent_id=? AND event_type='message.posted'")
    .get(identityId).n;

  // A plain room message reaches both seated subscribers — before the fix
  // the guest's identical subscription journaled zero deliveries.
  f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "hook-plain-1", body: "hello room" },
  });
  assert.equal(deliveriesFor(guest.identity.identityId), 1, "guest subscription receives the room event");
  assert.equal(deliveriesFor(linked.identityId), 1, "linked subscription still receives the room event");
  assert.equal(deliveriesFor(stranger.identityId), 0, "non-member subscription hears nothing");

  // Targeted-DM privacy fence: a DM to the linked member must not leak to
  // the guest subscriber (the guest seat's member id keeps the fence
  // meaningful for guests too).
  f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "hook-dm-1", body: "for linked only", toMemberId: "hook-linked" },
  });
  assert.equal(deliveriesFor(guest.identity.identityId), 1, "guest does not receive a third-party DM");
  assert.equal(deliveriesFor(linked.identityId), 2, "DM addressee's subscription receives the DM");

  // A DM addressed to the guest member DOES reach the guest's subscription.
  f.store.command(ownerKey, "commons", {
    id: randomUUID(), type: "message.posted",
    data: { messageId: "hook-dm-2", body: "for guest only", toMemberId: guest.memberId },
  });
  assert.equal(deliveriesFor(guest.identity.identityId), 2, "guest subscription receives its own DM");
  assert.equal(deliveriesFor(linked.identityId), 2, "linked subscriber does not receive the guest's DM");
  assert.equal(deliveriesFor(stranger.identityId), 0, "non-member subscription still hears nothing");
});

// Direct unit coverage of the shared resolver itself (the end-to-end legs
// above exercise it through the store/plugin surfaces): identity_links
// first, guest_members fallback, room-scoped, and defensive against
// pre-schema databases — a missing table reads as "no resolution".
function resolverDb(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE identity_links (
      room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
      member_id TEXT NOT NULL, linked_at INTEGER NOT NULL);
    CREATE TABLE guest_members (
      member_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      guest_identity_id TEXT NOT NULL, tier TEXT NOT NULL,
      invite_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO identity_links VALUES ('room-a', 'id-linked', 'mem-linked', 1);
    INSERT INTO identity_links VALUES ('room-b', 'id-other-room', 'mem-other', 1);
    INSERT INTO guest_members VALUES ('mem-guest', 'room-a', 'id-guest', 'contributor', 'inv-1', 1);
    INSERT INTO guest_members VALUES ('mem-both', 'room-a', 'id-guest-shadowed', 'observer', 'inv-2', 1);
    INSERT INTO identity_links VALUES ('room-a', 'id-linked-wins', 'mem-both', 1);
  `);
  return db;
}

test("resolver member -> identity: identity_links first, guest_members fallback", t => {
  const db = resolverDb(t);
  assert.equal(identityIdForWakeMember(db, "room-a", "mem-linked"), "id-linked",
    "identity_links row resolves directly");
  assert.equal(identityIdForWakeMember(db, "room-a", "mem-guest"), "id-guest",
    "trial seat resolves through the guest_members fallback");
  assert.equal(identityIdForWakeMember(db, "room-a", "mem-both"), "id-linked-wins",
    "identity_links wins when a member appears in both tables");
  assert.equal(identityIdForWakeMember(db, "room-a", "mem-absent"), null,
    "a member in neither table does not resolve");
  assert.equal(identityIdForWakeMember(db, "room-a", "mem-other"), null,
    "resolution is room-scoped: another room's link does not leak");
  assert.equal(identityIdForWakeMember(null, "room-a", "mem-linked"), null, "no db -> null");
  assert.equal(identityIdForWakeMember(db, "", "mem-linked"), null, "no room -> null");
  assert.equal(identityIdForWakeMember(db, "room-a", ""), null, "no member -> null");
});

test("resolver identity -> member: identity_links first, guest_members fallback", t => {
  const db = resolverDb(t);
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-linked"), "mem-linked",
    "identity_links row resolves directly");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-guest"), "mem-guest",
    "trial seat resolves through the guest_members fallback");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-guest-shadowed"), "mem-both",
    "a shadowed guest identity still resolves to its guest seat");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-absent"), null,
    "an identity in neither table does not resolve");
  assert.equal(memberIdForWakeIdentity(db, "room-a", "id-other-room"), null,
    "resolution is room-scoped: another room's identity does not leak");
  assert.equal(memberIdForWakeIdentity(null, "room-a", "id-linked"), null, "no db -> null");
  assert.equal(memberIdForWakeIdentity(db, "", "id-linked"), null, "no room -> null");
  assert.equal(memberIdForWakeIdentity(db, "room-a", ""), null, "no identity -> null");
});

test("resolver on a pre-schema database reads as no resolution, never a throw", t => {
  const bare = new DatabaseSync(":memory:");
  t.after(() => bare.close());
  assert.equal(identityIdForWakeMember(bare, "room-a", "mem-linked"), null,
    "missing tables -> null (member -> identity)");
  assert.equal(memberIdForWakeIdentity(bare, "room-a", "id-linked"), null,
    "missing tables -> null (identity -> member)");

  // Partial schema: identity_links exists, guest_members not yet created —
  // a link miss must still read as no resolution, not a throw.
  const partial = new DatabaseSync(":memory:");
  t.after(() => partial.close());
  partial.exec(`CREATE TABLE identity_links (
    room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    member_id TEXT NOT NULL, linked_at INTEGER NOT NULL);`);
  assert.equal(identityIdForWakeMember(partial, "room-a", "mem-guest"), null,
    "missing guest_members table -> null after a link miss");
  assert.equal(memberIdForWakeIdentity(partial, "room-a", "id-guest"), null,
    "missing guest_members table -> null after a link miss (reverse)");
});
