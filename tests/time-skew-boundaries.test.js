// Time-handling boundary tests (200-hard-tasks #173).
//
// Contract under test (owner boundary: verifyVettingReceipt /
// ReferralInvites.preview):
//   - the documented 5-minute clock-skew window is enforced exactly at the
//     millisecond: at+skew passes, at+skew+1ms is rejected;
//   - the 7-day freshness window is enforced exactly: at-maxAge passes,
//     at-maxAge-1ms is rejected;
//   - the skew window is future-only: widening it cannot revive a stale
//     receipt (expiry can't be bypassed by skew);
//   - skew never weakens the other checks: a future receipt inside the
//     window with a bad signature is still rejected;
//   - invite expiry is inclusive (expired at exactly expiresAt) and evaluated
//     on the server clock — preview() takes no client time at all, so a
//     backdated request cannot extend validity.
//
// (1) Observable behavior: exact tolerance boundaries. (2) Credible
// regression: an off-by-one or a skew-applies-to-staleness bug silently
// widens validity. (3) Existing coverage (tests/vetting-receipts.test.js)
// tests 10-minutes-ahead and 8-days-old — never the exact boundary, and
// never the skew-widening bypass. The L-22 invite-expiry-inclusive case was
// planned in tests/audit-wave-low-c.test.js but never written.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_VETTING_MAX_AGE_MS,
  generateReceiptKeyPair,
  issueVettingReceipt,
  verifyVettingReceipt,
} from "../server/vetting-receipts.mjs";
import { ReferralInvites, referralInviteSchema } from "../server/referral-invites.mjs";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const receiptParams = (issuedAt, issueNow) => ({
  trialTaskId: "trial-7f3a",
  demigodReqId: "req-0042",
  candidateId: "agent:rivet",
  scope: { hoursMax: "8", deliverableShape: "a working prototype PR" },
  rubricScores: [{ criterion: "correctness", scoreBps: "8500" }],
  verdict: "pass",
  evaluator: { kind: "human", id: "reviewer:ada" },
  issuedAt: new Date(issuedAt).toISOString(),
  receiptId: `vetting-receipt:${"cd".repeat(16)}`,
  now: issueNow,
});
const verifyOpts = (keypair, now, extra = {}) => ({
  expectedPubkey: keypair.pubkeyHex, seen: new Set(), now, ...extra,
});

test("clock-skew window is exact: at+skew verifies, at+skew+1ms is future_receipt", () => {
  const keypair = generateReceiptKeyPair();
  const edge = issueVettingReceipt(receiptParams(NOW + DEFAULT_CLOCK_SKEW_MS, NOW), keypair);
  assert.equal(verifyVettingReceipt(edge, verifyOpts(keypair, NOW)).ok, true);
  // Issued by a clock-skewed signer at its own reference time (valid signature);
  // the verifier's tighter clock must still reject it.
  const past = issueVettingReceipt(
    receiptParams(NOW + DEFAULT_CLOCK_SKEW_MS + 1, NOW + DEFAULT_CLOCK_SKEW_MS + 1), keypair);
  const check = verifyVettingReceipt(past, verifyOpts(keypair, NOW));
  assert.equal(check.ok, false);
  assert.match(check.reason, /^future_receipt/);
});

test("freshness window is exact: at-maxAge verifies, at-maxAge-1ms is stale_receipt", () => {
  const keypair = generateReceiptKeyPair();
  const edge = issueVettingReceipt(receiptParams(NOW - DEFAULT_VETTING_MAX_AGE_MS, NOW - DEFAULT_VETTING_MAX_AGE_MS), keypair);
  assert.equal(verifyVettingReceipt(edge, verifyOpts(keypair, NOW)).ok, true);
  const past = issueVettingReceipt(
    receiptParams(NOW - DEFAULT_VETTING_MAX_AGE_MS - 1, NOW - DEFAULT_VETTING_MAX_AGE_MS - 1), keypair);
  const check = verifyVettingReceipt(past, verifyOpts(keypair, NOW));
  assert.equal(check.ok, false);
  assert.match(check.reason, /^stale_receipt/);
});

test("widening clockSkewMs cannot revive a stale receipt: skew is future-only", () => {
  const keypair = generateReceiptKeyPair();
  const stale = issueVettingReceipt(
    receiptParams(NOW - DEFAULT_VETTING_MAX_AGE_MS - 1, NOW - DEFAULT_VETTING_MAX_AGE_MS - 1), keypair);
  // An attacker who could widen the skew window (or a bug that applied the
  // window to the stale bound) must still not revive expiry.
  const check = verifyVettingReceipt(stale, verifyOpts(keypair, NOW, { clockSkewMs: 60 * 60 * 1000 }));
  assert.equal(check.ok, false);
  assert.match(check.reason, /^stale_receipt/);
});

test("a future receipt inside the skew window with a bad signature is still rejected", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(receiptParams(NOW + 60 * 1000, NOW), keypair);
  const tampered = { ...receipt, verdict: "fail" };
  const check = verifyVettingReceipt(tampered, verifyOpts(keypair, NOW));
  assert.equal(check.ok, false);
  assert.match(check.reason, /^bad_signature/);
});

// --- invite expiry: inclusive and server-clock authoritative ----------------
// Fixture pattern from tests/audit-wave-low-c.test.js (L-21).
function inviteFixture(now) {
  const db = new DatabaseSync(":memory:");
  db.exec(referralInviteSchema);
  const store = {
    db,
    now: () => now,
    room: roomId => ({ state: { room: { title: "T" }, members: { inviter: { active: true } } } }),
    transaction: fn => fn(),
  };
  const invites = new ReferralInvites(store);
  const keys = invites.roomKeys("room1");
  return { db, store, invites, keys, setNow: next => { store.now = () => next; } };
}
function mintAt(invites, keys, issuedAt, ttlMs) {
  const body = {
    v: 1, jti: `jti-${issuedAt}`, chainId: "chain-1", roomId: "room1",
    depth: 0, maxDepth: 3, issuedAt, expiresAt: issuedAt + ttlMs, tier: "chat",
  };
  const token = invites.signToken(body, keys.privateSeed);
  invites.store.db.prepare(`INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth,
    created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minted')`)
    .run(body.jti, "room1", "chain-1", "inviter", 0, 3, issuedAt, body.expiresAt);
  return { token, expiresAt: body.expiresAt };
}

test("invite expiry is inclusive: valid at expiresAt-1ms, expired at expiresAt", () => {
  const issuedAt = 2_000_000;
  const { invites, keys, setNow } = inviteFixture(issuedAt);
  const { token, expiresAt } = mintAt(invites, keys, issuedAt, 3600_000);
  setNow(expiresAt - 1);
  assert.equal(invites.preview(token).roomId, "room1");
  setNow(expiresAt);
  assert.throws(() => invites.preview(token),
    err => err.status === 410 && err.code === "invite_expired");
});

test("invite expiry consults only the server clock: preview takes no client time", () => {
  const issuedAt = 3_000_000;
  const { invites, keys, setNow } = inviteFixture(issuedAt);
  const { token, expiresAt } = mintAt(invites, keys, issuedAt, 3600_000);
  // The requester presents a backdated request time. preview() has no time
  // parameter at all — the check reads this.now() (the server clock).
  setNow(expiresAt + 60_000);
  assert.throws(() => invites.preview(token, { requestTime: issuedAt }),
    err => err.status === 410 && err.code === "invite_expired",
    "a backdated client timestamp must not extend validity");
});
