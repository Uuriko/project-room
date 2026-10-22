// Issue #3908 (bug sweep 2026-10-16 lane 08, Low bundle) — regression specimens.
//
// F-7: the guest expiry sweeps (GuestInvites#sweepExpiredGuests and
// GuestAgentLinks#sweepExpired / its delegate flavor) judged a seat by ONE
// arbitrary unrevoked credential row. Guest re-redemption inserts a fresh
// credential WITHOUT revoking the prior one, so a seat can hold an expired
// unrevoked row alongside a live unrevoked row; the sweep read the expired
// row and deactivated a seat whose current credential is live.
//
// F-8: GET /api/wake-status room mode resolved membership through
// identity_links only, so a guest member got 403 room_membership_required
// for its own room and never appeared in the wakeable lists.
//
// F-9: guest-blind identity resolution on presence/naming surfaces —
// store.presence host presence, the room-key presence door, mention
// display names (identityNamesForRoom), and wake-pause reporting
// (pausedRoomsOf) all consulted identity_links only, so a guest seat
// (guest_members only) resolved to nothing on each.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { identityNamesForRoom } from "../server/mention-lifecycle.mjs";
import { roomKeyPresenceAuth } from "../server/room-key-presence.mjs";

const ROOM = "commons";
const ONE_HOUR = 3600 * 1000;
const sha = value => createHash("sha256").update(value).digest("hex");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-3908-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, request, ownerKey, origin, advance: ms => { clock += ms; }, now: () => clock };
}

async function mintInvite(request, ownerKey, extras = {}) {
  const res = await request(`/api/rooms/${ROOM}/guest-invites`, {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "3908 probe", expectedOwnerRevision: 0, ...extras },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function redeemGuest(request, store, code, name, identity = null) {
  const idn = identity ?? store.identities.create(`${name}-${randomUUID().slice(0, 6)}`);
  const keys = generateKeyPair();
  const cardBody = { name, description: "3908 probe", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: idn.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const res = await request("/api/guest-invites/redeem", {
    method: "POST", token: idn.secret, data: { inviteCode: code, card },
  });
  assert.ok(res.status === 201 || res.status === 200, `redeem: ${res.status}`);
  return { ...(await res.json()), identity: idn };
}

// Seat a guest holding TWO unrevoked credential rows: the first expires
// after one hour, the second (from re-redemption, which does not revoke
// the prior token) stays live far longer. Then advance past the first
// row's expiry.
async function seatWithExpiredAndLiveRows(t) {
  const ctx = await serve(t);
  const { store, request, ownerKey } = ctx;
  const inviteA = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const first = await redeemGuest(request, store, inviteA.code, "TwoRows");
  const inviteB = await mintInvite(request, ownerKey, { credentialTtlMs: 14 * 24 * ONE_HOUR });
  const second = await redeemGuest(request, store, inviteB.code, "TwoRows", first.identity);
  assert.equal(second.member.id, first.member.id, "re-redemption reuses the seat");
  const rows = store.db.prepare(
    "SELECT revoked, expires_at AS expiresAt FROM credentials WHERE room_id=? AND member_id=? AND kind='access' ORDER BY expires_at")
    .all(ROOM, first.member.id);
  assert.equal(rows.length, 2, "the seat holds two credential rows");
  assert.ok(rows.every(r => r.revoked === 0), "both rows are unrevoked (re-redemption revokes nothing)");
  ctx.advance(ONE_HOUR + 1000);
  return { ...ctx, guest: second, memberId: first.member.id };
}

test("F-7 specimen: sweepExpiredGuests keeps a seat whose older unrevoked row expired while a newer one is live", async t => {
  const { store, ownerKey, guest, memberId } = await seatWithExpiredAndLiveRows(t);
  const room = store.guestInvites.sweepExpiredGuests(ROOM, store.room(ROOM), "owner");
  assert.equal(room.state.members[memberId].active, true,
    "the seat survives: a live unrevoked credential row exists");
  assert.equal(store.authenticate(guest.token, ROOM).member.id, memberId,
    "the live credential still authenticates after the sweep");
  void ownerKey;
});

test("F-7 specimen: GuestAgentLinks#sweepExpired keeps the same seat", async t => {
  const { store, ownerKey, guest, memberId } = await seatWithExpiredAndLiveRows(t);
  store.guestAgentLinks.sweepExpired(ownerKey, ROOM, null);
  assert.equal(store.room(ROOM).state.members[memberId].active, true,
    "the mirror sweep also judges the seat by any live unrevoked row");
  assert.equal(store.authenticate(guest.token, ROOM).member.id, memberId);
});

test("F-7 adversarial specimen: a revoked future-expiry row plus an expired unrevoked row does NOT keep the seat", async t => {
  const { store, request, ownerKey, now } = await serve(t);
  const invite = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invite.code, "RevokedRow");
  const memberId = guest.member.id;
  // Revoke the only live row (its expiry is still in the future), and add
  // an unrevoked row that is already expired. No live unrevoked row
  // exists, so the sweep must still deactivate — a fix that merely checks
  // "some row has future expiry" or "some row is unrevoked" fails here.
  store.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(ROOM, memberId);
  store.db.prepare(`INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch)
    VALUES(?,?,?,'access',NULL,?,NULL,NULL)`).run(sha(`stale-${randomUUID()}`), ROOM, memberId, now() - 1000);
  const room = store.guestInvites.sweepExpiredGuests(ROOM, store.room(ROOM), "owner");
  assert.equal(room.state.members[memberId].active, false,
    "no live unrevoked row: the seat is swept despite the revoked row's future expiry");
});

test("F-8 specimen: a guest member reads its own room's wake status and appears in its lists", async t => {
  const { store, request, ownerKey } = await serve(t);
  const invite = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invite.code, "WakeGuest");
  const denied = await request(`/api/wake-status?roomId=${ROOM}`, { token: guest.identity.secret });
  assert.equal(denied.status, 200, `guest member reads wake status (got ${denied.status})`);
  const body = await denied.json();
  const listed = [...body.wakeable, ...body.notWakeable].map(e => e.agentId);
  assert.ok(listed.includes(guest.identity.identityId), "the guest identity appears in the room's wake lists");
  // Registration is established by heartbeat() (agent-wake-poll contract:
  // notePoll refuses unregistered agents and stamps nothing for them), so
  // the guest registers a host before its poll can read as wakeable.
  store.agentHeartbeats.heartbeat({ agentId: guest.identity.identityId, hostId: "wake-guest-host" });
  store.agentHeartbeats.notePoll({ agentId: guest.identity.identityId });
  const after = await (await request(`/api/wake-status?roomId=${ROOM}`, { token: guest.identity.secret })).json();
  assert.ok(after.wakeable.map(e => e.agentId).includes(guest.identity.identityId),
    "after polling, the guest reads as wakeable in its own room");
});

test("F-9 specimen: presence, room-key door, mention names, and wake-pause reporting all resolve a guest seat", async t => {
  const { store, request, ownerKey, now } = await serve(t);
  const invite = await mintInvite(request, ownerKey, { credentialTtlMs: ONE_HOUR });
  const guest = await redeemGuest(request, store, invite.code, "PresenceGuest");
  const memberId = guest.member.id, identityId = guest.identity.identityId;

  // Host presence: the guest identity heartbeats; the room presence read
  // must attribute that host status to the guest member.
  store.agentHeartbeats.heartbeat({ agentId: identityId, hostId: "guest-host" });
  const presence = store.presence(ownerKey, ROOM, []);
  const entry = presence.members.find(m => m.memberId === memberId);
  assert.ok(entry, "guest member is listed in presence");
  assert.equal(entry.ownerIdentityId, identityId, "presence resolves the guest member's identity");
  assert.equal(entry.presence?.status, "online", "guest member shows host presence");

  // Room-key presence door: the guest's own ga1. access token is exactly
  // the credential class this door exists for.
  const keyAuth = roomKeyPresenceAuth(store, guest.token);
  assert.equal(keyAuth.identityId, identityId, "the room-key door resolves the guest seat's identity");
  assert.equal(keyAuth.roomId, ROOM);

  // Mention display names: the identity's display name resolves for the
  // guest member id.
  assert.equal(identityNamesForRoom(store.db, ROOM)[memberId], guest.identity.displayName,
    "mention names resolve the guest identity's display name");

  // Wake-pause reporting: a pause on the guest member is reported back on
  // the guest identity's poll surface.
  store.db.prepare("INSERT INTO wake_queue_pause VALUES(?,?,?,?)").run(ROOM, memberId, now(), "governor check");
  store.db.prepare("INSERT INTO wake_queue_pause_by VALUES(?,?,?,?)").run(ROOM, memberId, "owner", "governor");
  const paused = store.agentHeartbeats.pausedRoomsOf(identityId);
  assert.deepEqual(paused.map(p => p.roomId), [ROOM], "the guest's wake pause is reported");
  assert.equal(paused[0].heldBy, "owner");
});
