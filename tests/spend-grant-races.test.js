// Spend-primitive concurrency races (slice D, qaD-fix-spend-race).
//
// Four invariants Dot's isolated proof (945eb307) and Instinct's review
// found broken in #1472's deployed code:
//
// 1. Cumulative room allowance: two concurrent priced calls must not commit
//    more than the room allowance in aggregate. chargeSpendBeforeCall took a
//    static headroom snapshot, so two 5c room_put_file calls against a 5c
//    allowance both settled (10c vs 5c).
// 2. Single-use admission: at most one in-flight authorization per
//    single-use grant, including overlapping calls with different nonces.
//    Revocation happened in settle(), after the tool ran.
// 3. Exactly-once charging for completed-request replay: re-presenting a
//    settled (grant, nonce) must return its receipt, not charge again.
// 4. Recovery of an already-paid receipt must succeed without fresh
//    headroom: the money already moved.
//
// Authoring gate: each test names the invariant it protects and fails on
// the pre-fix code for that exact reason (verified below by running before
// the fix). All go through exported production functions — no test-only
// seams. tests/spend-grants.test.js owns the basic nonce-lifecycle
// contract; this file owns the concurrency/recovery invariants.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { setSpendAllowance } from "../server/spend-allowance.mjs";
import {
  SpendGrantError,
  ensureSpendGrantsSchema,
  issueSpendGrant,
  authorizeSpend,
  chargeSpendBeforeCall,
} from "../server/spend-grants.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-races-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

// Owner + one t2 agent peer. Mirrors tests/spend-grants.test.js.
function roomWithPeer(t) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend room", purpose: "Paid tools", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  return { store, rooms, owner, peer, roomId, ownerMemberId, peerMemberId };
}

const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };
const spendError = (fn, { status, code }) => {
  const error = capture(fn);
  assert.ok(error instanceof SpendGrantError, `expected SpendGrantError, got ${error}`);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return error;
};

const authzCount = (db, roomId, agentId, status) =>
  db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ? AND agent_id = ? AND status = ?`)
    .get(roomId, agentId, status).n;

test("room allowance is enforced cumulatively across concurrent authorizations", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const { roomId, peerMemberId: agentId } = f;
  issueSpendGrant(f.store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: now,
  });
  // A 5c room allowance. Both calls below are priced against the SAME
  // static projection snapshot, the way two concurrent calls would.
  const authz = (nonce, allowanceCents = 5, committedCents = 0) =>
    authorizeSpend(f.store.db, {
      roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce,
      roomAllowanceCents: allowanceCents, roomCommittedCents: committedCents, nowMs: now,
    });
  const first = authz("race-a");
  assert.ok(first, "first 5c authorization against a 5c allowance succeeds");
  const refused = spendError(() => authz("race-b"), { status: 402, code: "payment_required" });
  assert.equal(refused.detail.reason, "room_allowance_exceeded");
  // The failed second call left no reservation behind.
  assert.equal(authzCount(f.store.db, roomId, agentId, "reserved"), 1);
  // Releasing the first call frees the allowance for the next one.
  assert.equal(first.void(), true);
  const retry = authz("race-c");
  assert.ok(retry, "voiding the first call frees the room allowance");
  assert.equal(retry.settle(), true);
});

test("chargeSpendBeforeCall refuses the second concurrent call against the room allowance", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const { store, roomId, peerMemberId: agentId } = f;
  setSpendAllowance(store, f.owner.secret, roomId, { allowanceCents: 5, requestId: randomUUID() });
  issueSpendGrant(store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: now,
  });
  const call = () => chargeSpendBeforeCall(store, f.peer.secret, "room_put_file", { roomId });
  const first = call();
  assert.ok(first, "first paid call authorizes");
  const refused = spendError(call, { status: 402, code: "payment_required" });
  assert.equal(refused.detail.reason, "room_allowance_exceeded");
  assert.equal(first.void(), true);
  assert.ok(call(), "after the void the allowance is free again");
});

test("single-use grants admit at most one in-flight authorization", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const { roomId, peerMemberId: agentId } = f;
  issueSpendGrant(f.store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", singleUse: true, nowMs: now,
  });
  const authz = nonce =>
    authorizeSpend(f.store.db, { roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce, nowMs: now });
  const first = authz("su-a");
  assert.ok(first, "first single-use authorization succeeds");
  // Overlapping call with a different nonce: the one-shot slot is taken.
  const refused = spendError(() => authz("su-b"), { status: 409, code: "single_use_in_flight" });
  assert.match(refused.message, /single-use/i);
  assert.equal(authzCount(f.store.db, roomId, agentId, "reserved"), 1, "no second reservation row");
  // A voided attempt frees the slot — the call never happened.
  assert.equal(first.void(), true);
  const second = authz("su-c");
  assert.ok(second, "voiding frees the single-use slot");
  // Settling consumes the grant: the next call is refused as revoked.
  assert.equal(second.settle(), true);
  const revoked = spendError(() => authz("su-d"), { status: 402, code: "payment_required" });
  assert.equal(revoked.detail.reason, "grant_revoked");
});

test("completed-request replay charges exactly once", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const { roomId, peerMemberId: agentId } = f;
  issueSpendGrant(f.store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "10", perTxCapCents: "10", nowMs: now,
  });
  const authz = nonce =>
    authorizeSpend(f.store.db, { roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce, nowMs: now });
  const first = authz("replay-1");
  assert.equal(first.settle(), true);
  const before = authzCount(f.store.db, roomId, agentId, "settled");
  // Re-presenting the settled nonce returns its receipt — no new charge.
  const receipt = authz("replay-1");
  assert.equal(receipt.replayed, "settled");
  assert.equal(authzCount(f.store.db, roomId, agentId, "settled"), before, "no new settled row");
  assert.equal(authzCount(f.store.db, roomId, agentId, "reserved"), 0, "no new reservation");
  assert.equal(receipt.settle(), true, "re-settling the receipt is idempotent");
  assert.equal(receipt.void(), false, "a settled receipt cannot be voided");
});

test("an already-paid receipt recovers without fresh headroom", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const { roomId, peerMemberId: agentId } = f;
  issueSpendGrant(f.store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "5", perTxCapCents: "5", nowMs: now,
  });
  const authz = (nonce, allowance) =>
    authorizeSpend(f.store.db, {
      roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce, nowMs: now,
      ...(allowance === undefined ? {} : { roomAllowanceCents: allowance, roomCommittedCents: 0 }),
    });
  authz("paid-1", 5).settle();
  // Grant cap is now exhausted AND the room allowance is exhausted: a fresh
  // call would be refused twice over. Re-presenting the paid receipt must
  // still succeed — the money already moved.
  const receipt = authz("paid-1", 0);
  assert.equal(receipt.replayed, "settled");
  assert.equal(receipt.settle(), true);
});
