// Share-link joins are referrals. Protects: a person or agent who joins
// through a room's share link (#join) is credited to the link's issuer on the
// referral board, exactly once per joiner, so "who brought whom" counts the
// invite path people actually use, not only one-time agent invite codes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("share-link joins credit the link's issuer on the referral board, once per joiner", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-share-referrals-"));
  const now = Date.now(), store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner"), linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(ownerKey, "commons", { requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 5, expectedMemberRevision: 0 }, null);

  const slot = store.createAccountSessionSlot(), redemptionId = randomUUID();
  const accept = () => {
    const current = store.accountSessionSlot(slot.token);
    return store.shareLinks.join(slot.token, linkToken, { displayName: "Alice", redemptionId,
      expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
  };
  const alice = accept();
  const agent = store.identities.create("Peer agent");
  store.shareLinks.joinAgent(agent.secret, linkToken, "Peer agent");
  // Retries take the duplicate path and never credit twice.
  assert.equal(accept().duplicate, true);
  assert.equal(store.shareLinks.joinAgent(agent.secret, linkToken, "Peer agent").duplicate, true);

  const board = store.referrals.board(ownerKey, "commons");
  assert.equal(board.myReferralCount, 2);
  assert.deepEqual(board.myReferrals.map(r => `${r.refereeMemberId}:${r.via}`).sort(),
    [`${agent.identityId}:invite`, `${alice.session.member.id}:invite`].sort());
  assert.deepEqual(board.leaderboard.map(entry => [entry.memberId, entry.referralCount]), [["owner", 2]]);
  assert.doesNotThrow(() => store.shareLinks.verify());
  assert.equal(store.verifyInvitationAudit().consistent, true);
});

test("creditReferral ignores a prototype-named issuer but credits a real member issuer (#3224)", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-share-referrals-proto-"));
  const now = Date.now(), store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  // A real member who has not been referred by anyone yet.
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "referee", displayName: "Referee", kind: "human", permissions: [] } });
  const credited = () => store.db.prepare("SELECT count(*) n FROM referrals WHERE room_id='commons' AND referee_member_id='referee'").get().n;
  // "toString" is not an own member: members["toString"] resolves through
  // Object.prototype, so a raw index would pose as an issuer and attempt a
  // bogus referral record. Through ownMember it is not a member at all.
  assert.doesNotThrow(() => store.transaction(() =>
    store.shareLinks.creditReferral({ room_id: "commons", issuer_member_id: "toString" }, "referee", now)));
  assert.equal(credited(), 0);
  // The same path with a real member issuer still records the referral.
  store.transaction(() => store.shareLinks.creditReferral({ room_id: "commons", issuer_member_id: "owner" }, "referee", now));
  assert.equal(credited(), 1);
});
