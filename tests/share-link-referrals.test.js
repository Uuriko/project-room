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
