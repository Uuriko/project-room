// #3390: the standalone settleSpend must consume single-use grants exactly
// like the authorize handle's settle() does.
//
// Single-use consumption lived only in the handle's settle(): on a real
// transition it reads the current terms and revokes the grant edge. The
// exported standalone settleSpend performed the same lease-aware
// transition and room-reservation release but never consumed the grant,
// so a "single-use" grant was reusable by anyone settling through that
// door. settleSpend has no production callers today (dormant door), but
// it is exported public API in the subsystem where charging is moving
// into the shared operation path (#3269) — the two settle forms must not
// carry different money semantics. W5 found this with a deterministic
// repro (w5-harness/repro-spend-singleuse-standalone.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerBareTransactions } from "./helpers/bare-db-transactions.mjs";
import { ensureGrantsSchema } from "../server/grants.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, authorizeSpend, settleSpend,
  spendGrantSummary, RESERVE_LEASE_MS,
} from "../server/spend-grants.mjs";

const ROOM = "singleuse-room";
const AGENT = "agent-a";
const T0 = 1_786_000_000_000;

function bareDb() {
  const db = registerBareTransactions(new DatabaseSync(":memory:"));
  ensureGrantsSchema(db);
  ensureAutonomyTiersSchema(db);
  ensureSpendGrantsSchema(db);
  return db;
}

const issue = (db, terms = {}) => issueSpendGrant(db, ROOM, AGENT, {
  grantedBy: "owner", capCents: "100", perTxCapCents: "50", nowMs: T0, ...terms });
const authorize = (db, nonce, nowMs = T0) =>
  authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 5, nonce, nowMs });
const refusedRevoked = error => error.code === "payment_required" && error.detail?.reason === "grant_revoked";

test("standalone settleSpend consumes a single-use grant (W5 sequence)", () => {
  const db = bareDb();
  issue(db, { singleUse: true });
  authorize(db, "S1");
  assert.equal(settleSpend(db, { roomId: ROOM, agentId: AGENT, nonce: "S1", nowMs: T0 }), true);
  assert.throws(() => authorize(db, "S2"), refusedRevoked,
    "after a standalone settle, the single-use grant is consumed: a fresh authorize is refused grant_revoked");
});

test("handle settle consumes a single-use grant (control)", () => {
  const db = bareDb();
  issue(db, { singleUse: true });
  const handle = authorize(db, "S1");
  assert.equal(handle.settle(T0), true);
  assert.throws(() => authorize(db, "S2"), refusedRevoked);
});

test("standalone settleSpend does NOT consume a multi-use grant", () => {
  const db = bareDb();
  issue(db);
  authorize(db, "S1");
  assert.equal(settleSpend(db, { roomId: ROOM, agentId: AGENT, nonce: "S1", nowMs: T0 }), true);
  authorize(db, "S2"); // accepted: the grant lives on
  assert.equal(spendGrantSummary(db, ROOM, AGENT)?.remainingCents, "90");
});

test("standalone settleSpend consumes only on a real transition (post-lease settle)", () => {
  const db = bareDb();
  issue(db, { singleUse: true });
  authorize(db, "S1");
  const afterLease = T0 + RESERVE_LEASE_MS + 1000;
  assert.equal(settleSpend(db, { roomId: ROOM, agentId: AGENT, nonce: "S1", nowMs: afterLease }), false,
    "a post-lease settle does not move the row (#3268)");
  // No consumption without a transition: a fresh authorize is accepted
  // (the expired S1 is reaped by it) instead of refused grant_revoked.
  authorize(db, "S2", afterLease);
});

test("standalone settleSpend with an unknown nonce returns false and consumes nothing", () => {
  const db = bareDb();
  issue(db, { singleUse: true });
  assert.equal(settleSpend(db, { roomId: ROOM, agentId: AGENT, nonce: "NOPE", nowMs: T0 }), false);
  authorize(db, "S1"); // grant untouched: the first real spend still works
});
