// Referral attribution: invite redemption and access-request approvals
// attribute joins to a referrer; the board API serves the newest-first
// graph and a plain leaderboard. No badges, no points, no expiry perks.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-referrals-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const accessRequests = new AccessRequests(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, accessRequests, ownerKey, roomId: "commons" };
}

function mintRedeem(store, ownerKey, roomId, name = "Newcomer") {
  const invite = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const redeemed = store.invites.redeem(invite.code, { displayName: name });
  return { invite, redeemed };
}

function referralEvents(store, roomId) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')='referral.completed'").all(roomId)
    .map(row => JSON.parse(row.body));
}

test("invite redemption writes referredBy on the member and journals exactly one referral.completed", t => {
  const { store, ownerKey, roomId } = fixture(t);
  const { redeemed } = mintRedeem(store, ownerKey, roomId, "Referral Recruit");
  const member = store.room(roomId).state.members[redeemed.memberId];
  assert.ok(member, "member exists");
  assert.equal(member.referredBy, "owner");
  const events = referralEvents(store, roomId);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.referrerMemberId, "owner");
  assert.equal(events[0].data.refereeMemberId, redeemed.memberId);
  assert.equal(events[0].data.via, "invite");
  assert.equal(typeof events[0].data.completedAt, "number");
  // Journal row exists exactly once too.
  const rows = store.db.prepare("SELECT * FROM referrals WHERE room_id=?").all(roomId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].referrer_member_id, "owner");
  assert.equal(rows[0].referee_member_id, redeemed.memberId);
  assert.equal(rows[0].via, "invite");
});

test("duplicate redemption of the same identity does not double-count the referral", t => {
  const { store, ownerKey, roomId } = fixture(t);
  const invite = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const identity = store.identities.create("Repeat Joiner");
  const first = store.invites.redeem(invite.code, { displayName: "Repeat Joiner", identitySecret: identity.secret });
  assert.equal(first.duplicate, false);
  // Same identity redeeming the burned code hits the duplicate path.
  const second = store.invites.redeem(invite.code, { displayName: "Repeat Joiner", identitySecret: identity.secret });
  assert.equal(second.duplicate, true);
  assert.equal(referralEvents(store, roomId).length, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM referrals WHERE room_id=?").get(roomId).n, 1);
});

test("invite preview names the inviter by display name, never member ids", t => {
  const { store, ownerKey, roomId } = fixture(t);
  const invite = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const preview = store.invites.preview(invite.code);
  assert.equal(preview.inviterDisplayName, store.room(roomId).state.members.owner.displayName);
  assert.ok(!("created_by" in preview) && !("createdBy" in preview), "no minter id leaks");
  assert.ok(!JSON.stringify(preview).includes("\"owner\""), "no member id in the payload");
});

test("access request with a matching 'who referred you?' attributes the join on approval", t => {
  const { store, accessRequests, ownerKey, roomId } = fixture(t);
  // A referrer joins first via invite.
  const { redeemed: referrer } = mintRedeem(store, ownerKey, roomId, "Pat Referrer");
  const identity = store.identities.create("Requesting Agent");
  const requested = accessRequests.request(roomId, {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], note: null,
    referredBy: "pat referrer", // case-insensitive match
    requestId: "ar-match-1",
  });
  assert.equal(requested.referredBy, "pat referrer");
  const decided = accessRequests.decide(ownerKey, roomId, "ar-match-1", { decision: "approve" });
  assert.equal(decided.status, "approved");
  const member = store.room(roomId).state.members[decided.memberId];
  assert.equal(member.referredBy, referrer.memberId);
  const events = referralEvents(store, roomId);
  assert.equal(events.length, 2); // invite join + access-request join
  const ar = events.find(e => e.data.via === "request");
  assert.ok(ar, "access-request referral journaled");
  assert.equal(ar.data.referrerMemberId, referrer.memberId);
  assert.equal(ar.data.refereeMemberId, decided.memberId);
});

test("unmatched 'who referred you?' still joins with no referrer", t => {
  const { store, accessRequests, ownerKey, roomId } = fixture(t);
  const identity = store.identities.create("Lone Agent");
  accessRequests.request(roomId, {
    identityId: identity.identityId, displayName: "Lone Agent",
    requestedPermissions: ["accept_work"], note: null,
    referredBy: "Nobody Here", requestId: "ar-nomatch-1",
  });
  const decided = accessRequests.decide(ownerKey, roomId, "ar-nomatch-1", { decision: "approve" });
  assert.equal(decided.status, "approved");
  const member = store.room(roomId).state.members[decided.memberId];
  assert.ok(!("referredBy" in member), "no attribution on the member");
  assert.equal(referralEvents(store, roomId).length, 0);
});

test("ambiguous display names do not falsely attribute", t => {
  const { store, accessRequests, ownerKey, roomId } = fixture(t);
  mintRedeem(store, ownerKey, roomId, "Sam Duplicate");
  mintRedeem(store, ownerKey, roomId, "sam duplicate"); // second member, same folded name
  const identity = store.identities.create("Confused Agent");
  accessRequests.request(roomId, {
    identityId: identity.identityId, displayName: "Confused Agent",
    requestedPermissions: ["accept_work"], note: null,
    referredBy: "Sam Duplicate", requestId: "ar-ambig-1",
  });
  const decided = accessRequests.decide(ownerKey, roomId, "ar-ambig-1", { decision: "approve" });
  assert.equal(decided.status, "approved");
  const member = store.room(roomId).state.members[decided.memberId];
  assert.ok(!("referredBy" in member), "ambiguous match attributes nothing");
  // Only the two invite joins journaled.
  assert.equal(referralEvents(store, roomId).length, 2);
});

test("a member cannot refer themselves", t => {
  const { store, roomId } = fixture(t);
  assert.throws(
    () => store.referrals.record({ roomId, referrerMemberId: "owner", refereeMemberId: "owner", via: "invite" }),
    /cannot refer themselves/
  );
});

test("referral.completed validation rejects bad shapes", t => {
  const { store, ownerKey, roomId } = fixture(t);
  const { redeemed } = mintRedeem(store, ownerKey, roomId, "Validate Me");
  assert.throws(() => store.referrals.record({ roomId, referrerMemberId: "nope", refereeMemberId: redeemed.memberId, via: "invite" }), /referrer is not an active member/);
  assert.throws(() => store.referrals.record({ roomId, referrerMemberId: "owner", refereeMemberId: redeemed.memberId, via: "carrier-pigeon" }), /via must be invite or request/);
});

async function serveBoard(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-referrals-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function get(origin, path, token) {
  const res = await fetch(`${origin}${path}`, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("GET /api/rooms/:roomId/referrals needs membership; returns newest-first graph and a plain leaderboard", async t => {
  const { store, origin, ownerKey } = await serveBoard(t);
  const roomId = "commons";
  // No token -> 401.
  const anon = await get(origin, `/api/rooms/${roomId}/referrals`, null);
  assert.equal(anon.status, 401);
  // Build referrals with controlled completion order: Alice refers two,
  // Bob refers one. Sleep-free ordering via explicit timestamps is not
  // possible through redeem(), so mint in sequence and rely on now() ms
  // resolution — instead assert via distinct completed_at after the fact.
  const a1 = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const r1 = store.invites.redeem(a1.code, { displayName: "Alice Recruit One" });
  const a2 = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const r2 = store.invites.redeem(a2.code, { displayName: "Alice Recruit Two" });
  const b1 = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const r3 = store.invites.redeem(b1.code, { displayName: "Bob Recruit" });
  // Re-point two referrals at Alice and one at Bob by re-recording is not
  // possible (exactly-once per referee) — instead check the owner-attributed
  // board shape: all three joins attribute to the owner minter.
  const res = await get(origin, `/api/rooms/${roomId}/referrals`, ownerKey);
  assert.equal(res.status, 200);
  const board = res.json;
  assert.equal(board.roomId, roomId);
  assert.equal(board.referrals.length, 3);
  // Newest first by completed_at.
  const times = board.referrals.map(r => r.completedAt);
  assert.deepEqual([...times].sort((x, y) => y - x), times);
  for (const row of board.referrals) {
    assert.equal(row.referrerDisplayName, store.room(roomId).state.members.owner.displayName);
    assert.equal(row.via, "invite");
    assert.ok(!("secret" in row) && !("identityId" in row), "no credential data");
  }
  // Leaderboard: owner first with 3.
  assert.equal(board.leaderboard[0].referralCount, 3);
  assert.equal(board.myReferralCount, 3);
  assert.equal(board.myReferrals.length, 3);
  void r1; void r2; void r3;
});

test("leaderboard ranks referrers by successful joins, most first", t => {
  const { store, ownerKey, roomId } = fixture(t);
  // Owner invites Alice; Alice's key then invites two more.
  const mk = store.invites.create(ownerKey, roomId, { profile: "contribute" });
  const alice = store.invites.redeem(mk.code, { displayName: "Alice Leader" });
  const aliceKey = store.issueAccessKey(roomId, alice.memberId);
  // Alice needs invite rights: grant invite_member via owner command.
  store.command(ownerKey, roomId, { id: "grant-invite-alice", type: "member.access_changed",
    data: { memberId: alice.memberId, expectedMemberRevision: store.room(roomId).state.members[alice.memberId].revision,
      permissions: ["accept_work", "invite_member"], active: true } });
  const i1 = store.invites.create(aliceKey, roomId, { profile: "contribute" });
  store.invites.redeem(i1.code, { displayName: "Alice Fan One" });
  const i2 = store.invites.create(aliceKey, roomId, { profile: "contribute" });
  store.invites.redeem(i2.code, { displayName: "Alice Fan Two" });
  const board = store.referrals.board(aliceKey, roomId);
  const ranked = board.leaderboard.map(e => [e.displayName, e.referralCount]);
  assert.deepEqual(ranked[0], ["Alice Leader", 2]);
  assert.deepEqual(ranked[1], [store.room(roomId).state.members.owner.displayName, 1]);
  assert.equal(board.myReferralCount, 2);
  assert.equal(board.myReferrals.length, 2);
});
