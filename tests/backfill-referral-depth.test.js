import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-referral-backfill-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  return { store, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

// bob/carol redeemed invites carrying caps 3/5; dave has no redeemed invite;
// erin already carries a cap.
function seedReferrals(store) {
  store.db.exec(`
    INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status, redeemed_member_id)
    VALUES
      ('jti-1', 'room-a', 'chain-1', 'alice', 0, 3, 1, 9999999999999, 'redeemed', 'bob'),
      ('jti-2', 'room-a', 'chain-1', 'alice', 1, 5, 1, 9999999999999, 'redeemed', 'carol'),
      ('jti-3', 'room-a', 'chain-1', 'alice', 2, 7, 1, 9999999999999, 'minted', NULL);
    INSERT INTO referral_chain_members (room_id, member_id, chain_id, depth, max_depth)
    VALUES
      ('room-a', 'bob', 'chain-1', 1, NULL),
      ('room-a', 'carol', 'chain-1', 2, NULL),
      ('room-a', 'dave', 'chain-1', 3, NULL),
      ('room-a', 'erin', 'chain-1', 4, 9);
  `);
}

function caps(store) {
  return Object.fromEntries(store.db.prepare(
    "SELECT member_id, max_depth FROM referral_chain_members ORDER BY member_id").all()
    .map(row => [row.member_id, row.max_depth]));
}

test("backfillReferralDepth copies each redeemed invite cap onto its chain member", () => {
  const fixture = openStore();
  try {
    seedReferrals(fixture.store);
    const updated = fixture.store.backfillReferralDepth(500);
    assert.equal(updated, 3);
    assert.deepEqual(caps(fixture.store), { bob: 3, carol: 5, dave: null, erin: 9 });
  } finally { fixture.close(); }
});

test("backfillReferralDepth respects the row limit", () => {
  const fixture = openStore();
  try {
    seedReferrals(fixture.store);
    assert.equal(fixture.store.backfillReferralDepth(1), 1);
    assert.equal(fixture.store.backfillReferralDepth(500), 2);
    assert.deepEqual(caps(fixture.store), { bob: 3, carol: 5, dave: null, erin: 9 });
  } finally { fixture.close(); }
});

test("backfillReferralDepth reprocesses members with no redeemed invite (never converges)", () => {
  const fixture = openStore();
  try {
    seedReferrals(fixture.store);
    fixture.store.backfillReferralDepth(500);
    // dave's cap stays NULL: the mint path refuses a NULL cap, so the tick
    // fails closed and dave is picked up again on the next run.
    assert.equal(fixture.store.backfillReferralDepth(500), 1);
    assert.equal(caps(fixture.store).dave, null);
  } finally { fixture.close(); }
});

test("backfillReferralDepth returns 0 when the table is missing", () => {
  const fixture = openStore();
  try {
    fixture.store.db.exec("DROP TABLE referral_chain_members");
    assert.equal(fixture.store.backfillReferralDepth(500), 0);
  } finally { fixture.close(); }
});
