// S2a: unified signed-receipt lookup — BountyEscrow.getSignedReceipt(roomId, receiptId).
//
// Design: proof-layer lane B2 §2 (adopted whole by the R5 build charter §3 S2).
// The lookup is a dumb, total retriever over the bodies that already persist:
//   leg A  bounty_receipts (post-S1 store; the probe is existence-guarded, so
//          pre-S1 databases — every database today — are tolerated)
//   leg C  bounty_events epoch.closed summary bodies
//   leg D  bounty_idempotency.response whole response bodies (B7 M-7: the
//          extraction walk covers every persisted response shape in the tree)
//   leg E  public_work_review_requests outcome journal
// Verification is the serving layer's job (S4); this suite pins retrieval,
// provenance (`source`), the cross-room guard, the shape gate, and the
// duplicate/mismatch rule.
//
// TEST KEYS ONLY: the signer below is the public reference-vector key from
// tests/bounty-receipts.test.js, labelled test-only there and here.
//
// Run: node --test tests/bounty-signed-receipt-lookup.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createReceiptSigner } from "../server/bounty-receipts.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

// The operator TEST key: the dasha-receipt/1 reference-vector seed (public,
// printed in tests/bounty-receipts.test.js). Never a production key.
const TEST_SEED = "9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60";

const ROOM = "room-test";
const OTHER_ROOM = "room-other";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT s2a_test");
    try { const out = fn(); db.exec("RELEASE s2a_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO s2a_test"); db.exec("RELEASE s2a_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true,
    receipts: createReceiptSigner({ seedHex: TEST_SEED, ref: "test-operator" }) });
  escrow.ensureGenesis(ROOM);
  return { escrow, db, store };
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 5, deadline: isoFuture(3_600_000), ...overrides }).bounty;

function runToAccepted(escrow) {
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation:
    { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// Settle one accepted bounty through an epoch close; returns the payout body
// persisted inside the epoch.closed event (leg C).
function epochPayout(escrow) {
  const bounty = runToAccepted(escrow);
  nowMs += 3 * 24 * 3600 * 1000 + 1; // challenge window elapses
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  const { summary } = escrow.closeEpoch(ROOM, {});
  const bodies = summary.signedReceipts?.[bounty.bountyId] ?? [];
  const payout = bodies.find(body => body.type === "payout-released");
  assert.ok(payout, "epoch close issued a payout-released body");
  return { bounty, payout };
}

test("leg C: an epoch-settled payout body is found with source epoch.closed", () => {
  const { escrow } = makeEscrow();
  const { bounty, payout } = epochPayout(escrow);
  const found = escrow.getSignedReceipt(ROOM, payout.receiptId);
  assert.ok(found, "lookup returned a result");
  assert.equal(found.source, "epoch.closed");
  assert.equal(found.roomId, ROOM);
  assert.equal(found.bountyId, bounty.bountyId);
  assert.deepEqual(found.receipt, payout);
  assert.equal(found.mismatch, undefined);
});

test("leg D: a keyed finalizeBounty body is found via bounty_idempotency", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  nowMs += 3_600_000 + 1; // past the claim deadline: finalize refunds
  const result = escrow.idemExecute(ROOM, "finalize-key-1", "bounty.finalize", 200,
    () => escrow.finalizeBounty(ROOM, bounty.bountyId, {}),
    { callerLane: JILL, bountyId: bounty.bountyId, payload: {} });
  const [body] = result.body.receipt.signed;
  assert.ok(body, "finalize issued a signed body");
  const found = escrow.getSignedReceipt(ROOM, body.receiptId);
  assert.ok(found, "lookup returned a result");
  assert.equal(found.source, "bounty_idempotency");
  assert.deepEqual(found.receipt, body);
});

test("leg D corpus: every persisted response shape in the tree yields its bodies", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow);
  const { receipt } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const [body] = receipt.signed;
  // Representative persisted shapes (B7 M-7 discovery over the route/tool
  // response shapes in server/bounty-escrow.mjs + the route wrappers):
  // transition returns, finalize/dispute-settle returns, closeEpoch returns,
  // and wrapper-nested variants of each.
  const shapes = {
    "transition receipt.signed": { bounty: {}, receipt: { kind: "fund", signed: [body] } },
    "finalize receipt.signed": { bounty: {}, action: "refunded", receipt: { kind: "finalize", signed: [body] } },
    "dispute-settle receipt.signed": { receipt: { kind: "dispute-settle", signed: [body] } },
    "closeEpoch summary.signedReceipts": { summary: { signedReceipts: { [bounty.bountyId]: [body] } } },
    "epoch-wrapped summary": { epoch: { summary: { signedReceipts: { [bounty.bountyId]: [body] } } } },
    "deeply nested result": { result: { receipt: { signed: [body] } } },
  };
  let n = 0;
  for (const [name, shape] of Object.entries(shapes)) {
    db.prepare(`INSERT INTO bounty_idempotency (room_id, idem_key, route, status, response, created_at, scope_key, caller_lane, version, request_hash)
      VALUES (?,?,?,?,?,?,?,?,2,?)`)
      .run(ROOM, `corpus-${n}`, "bounty.corpus", 200, JSON.stringify(shape), new Date(nowMs).toISOString(), `scope-${n}`, JILL, null);
    n += 1;
    const found = escrow.getSignedReceipt(ROOM, body.receiptId);
    assert.ok(found, `${name}: body found`);
    assert.equal(found.source, "bounty_idempotency", `${name}: source`);
    assert.deepEqual(found.receipt, body, `${name}: body round-trips`);
    db.prepare("DELETE FROM bounty_idempotency WHERE room_id=?").run(ROOM);
  }
});

test("leg E: a public-work verdict body is found via the review journal", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const { receipt } = escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation:
    { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  const [body] = receipt.signed;
  // The verdict journal's own table (schema: server/public-work-reviews.mjs).
  db.exec(`CREATE TABLE IF NOT EXISTS public_work_review_requests (
    room_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
    input_json TEXT NOT NULL, outcome_json TEXT NOT NULL,
    PRIMARY KEY(room_id,actor_id,request_id));`);
  const outcome = { settlement: { escrowReceipt: { kind: "accept", signed: [body] } } };
  db.prepare("INSERT INTO public_work_review_requests VALUES (?,?,?,?,?)")
    .run(ROOM, JILL, "req-1", "{}", JSON.stringify(outcome));
  const found = escrow.getSignedReceipt(ROOM, body.receiptId);
  assert.ok(found, "lookup returned a result");
  assert.equal(found.source, "public_work_review");
  assert.deepEqual(found.receipt, body);
});

test("leg A: absence of bounty_receipts is tolerated; a present table wins precedence", () => {
  const { escrow, db } = makeEscrow();
  const { payout } = epochPayout(escrow);
  // Pre-S1 database (no bounty_receipts table): the leg-C hit above already
  // proves tolerance; assert the table really is absent here.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bounty_receipts'").all();
  assert.equal(tables.length, 0, "fixture database has no bounty_receipts table");
  assert.equal(escrow.getSignedReceipt(ROOM, payout.receiptId).source, "epoch.closed");
  // Post-S1 shape (B2 §1.1 DDL): the same lookup's leg A goes live with no
  // code change — S2b, S1's acceptance state, proven here against the DDL.
  db.exec(`CREATE TABLE IF NOT EXISTS bounty_receipts (
    receipt_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, bounty_id TEXT, lot_id TEXT,
    type TEXT NOT NULL, issuer_pubkey TEXT NOT NULL, issued_at TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)));
  CREATE INDEX IF NOT EXISTS bounty_receipts_room ON bounty_receipts(room_id, bounty_id);
  CREATE INDEX IF NOT EXISTS bounty_receipts_issued ON bounty_receipts(room_id, issued_at);`);
  db.prepare("INSERT INTO bounty_receipts VALUES (?,?,?,?,?,?,?,?)")
    .run(payout.receiptId, ROOM, payout.bountyId, payout.lotId, payout.type,
      payout.issuer.pubkey, payout.issuedAt, JSON.stringify(payout));
  const found = escrow.getSignedReceipt(ROOM, payout.receiptId);
  assert.equal(found.source, "bounty_receipts", "leg A takes precedence once the table exists");
  assert.deepEqual(found.receipt, payout);
  assert.equal(found.mismatch, undefined, "byte-identical duplicates are not a mismatch");
});

test("cross-room receiptId resolves to null — the ID is never a cross-room oracle", () => {
  const { escrow } = makeEscrow();
  const { payout } = epochPayout(escrow);
  assert.equal(escrow.getSignedReceipt(OTHER_ROOM, payout.receiptId), null);
});

test("malformed receiptIds return null with no DB read (shape gate)", () => {
  const throwingDb = { prepare() { throw new Error("db must not be touched"); } };
  const store = { db: throwingDb, transaction: fn => fn(), readTransaction: fn => fn() };
  const escrow = new BountyEscrow(store, { allowLegacyStringLanes: true });
  for (const bad of ["room-bounty-receipt:pr:xyz", "room-bounty-receipt:xx:" + "a".repeat(32),
    "room-bounty-receipt:pr:" + "A".repeat(32), "lot_" + "a".repeat(16), "", null, undefined, 42, {}]) {
    assert.equal(escrow.getSignedReceipt(ROOM, bad), null, `malformed ${JSON.stringify(bad)}`);
  }
  assert.equal(escrow.getSignedReceipt(ROOM, "room-bounty-receipt:pr:" + "0".repeat(32)), null,
    "well-formed but never issued also resolves to null (every leg guarded, none throws)");
});

test("disagreeing legs return the highest-precedence copy with mismatch: true", () => {
  const { escrow, db } = makeEscrow();
  const { bounty, payout } = epochPayout(escrow);
  // Plant a disagreeing copy in leg D: same receiptId and signature string,
  // a different signed field — canonical re-encoding differs.
  const tampered = { ...payout, amountMillis: "1" };
  db.prepare(`INSERT INTO bounty_idempotency (room_id, idem_key, route, status, response, created_at, scope_key, caller_lane, version, request_hash)
    VALUES (?,?,?,?,?,?,?,?,2,?)`)
    .run(ROOM, "mismatch-1", "bounty.fund", 200,
      JSON.stringify({ receipt: { kind: "fund", signed: [tampered] } }),
      new Date(nowMs).toISOString(), "scope-mismatch", JILL, null);
  assert.ok(bounty.bountyId);
  const found = escrow.getSignedReceipt(ROOM, payout.receiptId);
  assert.ok(found, "lookup returned a result");
  assert.equal(found.source, "epoch.closed", "highest-precedence copy wins");
  assert.deepEqual(found.receipt, payout);
  assert.equal(found.mismatch, true, "disagreement is surfaced, not hidden");
});

test("byte-identical duplicates across legs are not a mismatch", () => {
  const { escrow, db } = makeEscrow();
  const { payout } = epochPayout(escrow);
  db.prepare(`INSERT INTO bounty_idempotency (room_id, idem_key, route, status, response, created_at, scope_key, caller_lane, version, request_hash)
    VALUES (?,?,?,?,?,?,?,?,2,?)`)
    .run(ROOM, "dup-1", "bounty.epoch", 200,
      JSON.stringify({ summary: { signedReceipts: { [payout.bountyId]: [payout] } } }),
      new Date(nowMs).toISOString(), "scope-dup", JILL, null);
  const found = escrow.getSignedReceipt(ROOM, payout.receiptId);
  assert.equal(found.source, "epoch.closed");
  assert.equal(found.mismatch, undefined);
});
