// Tests for receipt signer Option B: server/decision-receipts.mjs, the
// env wiring in server/bounty-receipts.mjs, and the BountyEscrow
// integration (pre-execution decision issuance in _move, digest binding
// on outcome receipts, decision surfacing).
//
// The falsifier battery is the point: every fabricated / replayed /
// tampered / unbound pair MUST fail pair verification, and the genuine
// keeper-issued pair MUST pass. Throwaway keys only — generated in-memory
// per run, never persisted, never a production seed.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  generateReceiptKeyPair,
  createReceiptSigner,
  issueBountyReceipt,
  verifyBountyReceipt,
  receiptSignerFromEnv,
  RECEIPT_SIGNER_SEED_ENV,
  RECEIPT_SIGNER_REF_ENV,
  DEFAULT_RECEIPT_SIGNER_REF,
} from "../server/bounty-receipts.mjs";
import {
  DECISION_SCHEMA_VERSION,
  issueDecisionReceipt,
  decisionDigest,
  verifyDecisionReceipt,
  verifyDecisionOutcomePair,
} from "../server/decision-receipts.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

// --- throwaway keys (in-memory only) -----------------------------------------
const OPERATOR = generateReceiptKeyPair();
const ATTACKER = generateReceiptKeyPair();
const operatorIssuer = { pubkey: OPERATOR.pubkeyHex, role: "escrow-keeper", ref: "test-operator" };
const attackerIssuer = { pubkey: ATTACKER.pubkeyHex, role: "escrow-keeper", ref: "mallory" };

const ISSUED_AT = "2026-11-03T12:00:00.000Z";
const ACTOR = { kind: "agent", id: "id:agent/jill" };
const ROOM_ID = "room-test";
const BOUNTY_ID = "ROOM-1";
const LOT_ID = "lot_cccccccccccccccc";
const ENTRIES = ["ent_aaaaaaaaaaaaaaaa", "ent_bbbbbbbbbbbbbbbb"];
const HASHES = ["a".repeat(64), "b".repeat(64)];

function issueDecision(overrides = {}) {
  return issueDecisionReceipt({
    act: "escrow-locked",
    target: { roomId: ROOM_ID, bountyId: BOUNTY_ID, lotId: LOT_ID },
    disposition: "escrow-lock: id:agent/jill/payable -> id:agent/jill/locked",
    amountMillis: "10000",
    actor: ACTOR,
    issuer: operatorIssuer,
    decidedAt: ISSUED_AT,
    seedHex: OPERATOR.seedHex,
    ...overrides,
  });
}

function issueOutcome(decision, overrides = {}) {
  return issueBountyReceipt({
    type: "escrow-locked",
    roomId: ROOM_ID, bountyId: BOUNTY_ID, lotId: LOT_ID, amountMillis: "10000",
    actor: ACTOR, entries: ENTRIES, entryHashes: HASHES,
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable",
      decisionId: decision.decisionId, decisionDigest: decisionDigest(decision) },
    issuer: operatorIssuer, issuedAt: ISSUED_AT, seedHex: OPERATOR.seedHex,
    ...overrides,
  });
}

const genuinePair = () => { const decision = issueDecision(); return { decision, outcome: issueOutcome(decision) }; };
const clone = v => JSON.parse(JSON.stringify(v));

// --- controls ------------------------------------------------------------------

test("control: a genuine decision + bound outcome pair verifies", () => {
  const { decision, outcome } = genuinePair();
  assert.equal(decision.schemaVersion, DECISION_SCHEMA_VERSION);
  assert.match(decision.decisionId, /^room-decision:[0-9a-f]{32}$/);
  assert.match(decision.nonce, /^[0-9a-f]{32}$/);
  assert.equal(outcome.payload.decisionId, decision.decisionId);
  assert.equal(outcome.payload.decisionDigest, decisionDigest(decision));
  const v = verifyDecisionOutcomePair(decision, outcome, { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, true, `genuine pair rejected: ${JSON.stringify(v)}`);
  assert.equal(v.decisionId, decision.decisionId);
  assert.equal(v.receiptId, outcome.receiptId);
  // The JSON-text path parses strictly and verifies identically.
  const vt = verifyDecisionOutcomePair(JSON.stringify(decision), JSON.stringify(outcome),
    { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(vt.ok, true, `text-path pair rejected: ${JSON.stringify(vt)}`);
  // The decision also verifies standalone; the digest ignores the signature field.
  assert.equal(verifyDecisionReceipt(decision, { expectedPubkey: OPERATOR.pubkeyHex }).ok, true);
  const unsigned = clone(decision); delete unsigned.signature;
  assert.equal(decisionDigest(unsigned), decisionDigest(decision));
  // Two decisions never share an id or a nonce.
  const other = issueDecision();
  assert.notEqual(other.decisionId, decision.decisionId);
  assert.notEqual(other.nonce, decision.nonce);
});

test("control: the outcome alone still verifies as an ordinary bounty receipt", () => {
  const { outcome } = genuinePair();
  assert.equal(verifyBountyReceipt(outcome, { expectedPubkey: OPERATOR.pubkeyHex }).ok, true);
  // An unbound outcome (no decision keys at all) also stays shape-valid:
  // binding is optional in the schema, mandatory only for pair verification.
  const unbound = issueBountyReceipt({
    type: "escrow-locked", roomId: ROOM_ID, bountyId: BOUNTY_ID, lotId: LOT_ID, amountMillis: "10000",
    actor: ACTOR, entries: ENTRIES, entryHashes: HASHES,
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable" },
    issuer: operatorIssuer, issuedAt: ISSUED_AT, seedHex: OPERATOR.seedHex });
  assert.equal(verifyBountyReceipt(unbound, { expectedPubkey: OPERATOR.pubkeyHex }).ok, true);
});

// --- falsifier battery -----------------------------------------------------------

test("falsifier (a): fabricated outcome carrying a signature copied from a genuine decision fails", () => {
  const { decision, outcome } = genuinePair();
  // A self-report shaped exactly like the genuine outcome — correct binding
  // included — but "signed" by pasting the decision receipt's signature,
  // the only genuine signature the fabricator has seen.
  const fabricated = { ...clone(outcome), signature: decision.signature };
  const v = verifyDecisionOutcomePair(decision, fabricated, { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, false, "fabricated outcome accepted");
  assert.match(v.reason, /bad_signature/);
});

test("falsifier (b): a pair signed with an attacker-generated key fails the expected-key check", () => {
  // Fully self-consistent attacker pair: attacker's decision, attacker's
  // outcome, correct binding — a complete agent self-report.
  const decision = issueDecision({ issuer: attackerIssuer, seedHex: ATTACKER.seedHex });
  const outcome = issueOutcome(decision, { issuer: attackerIssuer, seedHex: ATTACKER.seedHex });
  // Internally consistent without an expected key (documents why the
  // expected key is the load-bearing check)...
  assert.equal(verifyDecisionOutcomePair(decision, outcome).ok, true);
  // ...and rejected against the operator key this context trusts.
  const v = verifyDecisionOutcomePair(decision, outcome, { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, false, "attacker-signed pair accepted");
  assert.match(v.reason, /unexpected_signer/);
  // Mixed pair: genuine decision, attacker-signed outcome.
  const genuine = issueDecision();
  const mixed = issueOutcome(genuine, { issuer: attackerIssuer, seedHex: ATTACKER.seedHex });
  const vm = verifyDecisionOutcomePair(genuine, mixed, { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(vm.ok, false, "attacker-signed outcome accepted");
  assert.match(vm.reason, /unexpected_signer/);
});

test("falsifier (c): a genuine pair presented twice fails the second time (single-use)", () => {
  const { decision, outcome } = genuinePair();
  const consumed = new Set();
  assert.equal(verifyDecisionOutcomePair(decision, outcome,
    { expectedPubkey: OPERATOR.pubkeyHex, consumed }).ok, true);
  assert.ok(consumed.has(decision.decisionId), "successful verification consumes the decision");
  const second = verifyDecisionOutcomePair(decision, outcome,
    { expectedPubkey: OPERATOR.pubkeyHex, consumed });
  assert.equal(second.ok, false, "replayed pair accepted");
  assert.match(second.reason, /decision_consumed/);
  // A FAILED presentation must not consume: tamper first, then the genuine
  // pair still verifies against the same set.
  const pair2 = genuinePair();
  const tampered = { ...clone(pair2.outcome), amountMillis: "9999" };
  assert.equal(verifyDecisionOutcomePair(pair2.decision, tampered,
    { expectedPubkey: OPERATOR.pubkeyHex, consumed }).ok, false);
  assert.equal(verifyDecisionOutcomePair(pair2.decision, pair2.outcome,
    { expectedPubkey: OPERATOR.pubkeyHex, consumed }).ok, true,
    "failed presentation must not burn the decision");
});

test("falsifier (d): amount or target altered after signing fails", () => {
  const { decision, outcome } = genuinePair();
  const opts = { expectedPubkey: OPERATOR.pubkeyHex };
  // Outcome amount altered.
  const badAmount = { ...clone(outcome), amountMillis: "9999" };
  assert.equal(verifyDecisionOutcomePair(decision, badAmount, opts).ok, false, "altered outcome amount accepted");
  // Outcome target altered.
  const badLot = { ...clone(outcome), lotId: "lot_dddddddddddddddd" };
  const vLot = verifyDecisionOutcomePair(decision, badLot, opts);
  assert.equal(vLot.ok, false, "altered outcome lot accepted");
  assert.match(vLot.reason, /bad_signature/);
  // Decision amount altered (its own signature no longer covers it).
  const badDecisionAmount = { ...clone(decision), amountMillis: "1" };
  const vda = verifyDecisionOutcomePair(badDecisionAmount, outcome, opts);
  assert.equal(vda.ok, false, "altered decision amount accepted");
  assert.match(vda.reason, /bad_signature/);
  // Decision target altered.
  const badTarget = clone(decision); badTarget.target.roomId = "room-other";
  assert.equal(verifyDecisionOutcomePair(badTarget, outcome, opts).ok, false, "altered decision target accepted");
  // Agreement layer, isolated: a genuine-key decision for a DIFFERENT
  // amount, with an outcome correctly bound to it by id + digest — every
  // signature is individually valid, so only the agreement check can catch
  // that the executed amount is not the authorised amount.
  const otherDecision = issueDecision({ amountMillis: "5000" });
  const reSigned = issueBountyReceipt({
    type: "escrow-locked", roomId: ROOM_ID, bountyId: BOUNTY_ID, lotId: LOT_ID, amountMillis: "10000",
    actor: ACTOR, entries: ENTRIES, entryHashes: HASHES,
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable",
      decisionId: otherDecision.decisionId, decisionDigest: decisionDigest(otherDecision) },
    issuer: operatorIssuer, issuedAt: ISSUED_AT, seedHex: OPERATOR.seedHex });
  const vSwap = verifyDecisionOutcomePair(otherDecision, reSigned, opts);
  assert.equal(vSwap.ok, false, "amount disagreement between decision and outcome accepted");
  assert.match(vSwap.reason, /decision_mismatch/);
});

test("falsifier (e): an outcome with no decision binding presented as a pair fails", () => {
  const decision = issueDecision();
  const unbound = issueBountyReceipt({
    type: "escrow-locked", roomId: ROOM_ID, bountyId: BOUNTY_ID, lotId: LOT_ID, amountMillis: "10000",
    actor: ACTOR, entries: ENTRIES, entryHashes: HASHES,
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable" },
    issuer: operatorIssuer, issuedAt: ISSUED_AT, seedHex: OPERATOR.seedHex });
  const v = verifyDecisionOutcomePair(decision, unbound, { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, false, "unbound outcome accepted as a pair");
  assert.match(v.reason, /unbound_outcome/);
  // Cross-pair mixup: two genuine pairs, halves swapped — binding ids differ.
  const a = genuinePair(), b = genuinePair();
  const vMix = verifyDecisionOutcomePair(a.decision, b.outcome, { expectedPubkey: OPERATOR.pubkeyHex });
  assert.equal(vMix.ok, false, "cross-pair halves accepted");
  assert.match(vMix.reason, /decision_mismatch/);
  // A half binding (decisionId without its digest) is malformed, not
  // partial: issuance refuses it at shape validation...
  assert.throws(() => issueBountyReceipt({
    type: "escrow-locked", roomId: ROOM_ID, bountyId: BOUNTY_ID, lotId: LOT_ID, amountMillis: "10000",
    actor: ACTOR, entries: ENTRIES, entryHashes: HASHES,
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable", decisionId: decision.decisionId },
    issuer: operatorIssuer, issuedAt: ISSUED_AT, seedHex: OPERATOR.seedHex }),
    /must appear together/, "lone decisionId must fail outcome shape validation");
  // ...and a hand-assembled half-bound outcome fails verification too.
  const genuine = genuinePair();
  const halfBound = clone(genuine.outcome); delete halfBound.payload.decisionDigest;
  assert.equal(verifyBountyReceipt(halfBound).ok, false, "lone decisionId must fail verification");
});

// --- env surface -----------------------------------------------------------------

test("env surface: unset/blank seed is inert, invalid seed throws, ref defaults and overrides", () => {
  assert.equal(receiptSignerFromEnv({}), null, "unset seed -> null");
  assert.equal(receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: "" }), null, "empty seed -> null");
  assert.equal(receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: "   " }), null, "blank seed -> null");
  assert.equal(receiptSignerFromEnv(null), null, "no env at all -> null");
  assert.throws(() => receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: "zz" }),
    e => e.code === "invalid_key" && /seed must be 64 lowercase hex/.test(e.message),
    "present-but-invalid seed must fail loudly");
  assert.throws(() => receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: OPERATOR.seedHex.slice(1) }),
    e => e.code === "invalid_key",
    "truncated seed must fail loudly");
  const signer = receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: OPERATOR.seedHex });
  assert.equal(signer.pubkeyHex, OPERATOR.pubkeyHex);
  assert.equal(signer.ref, DEFAULT_RECEIPT_SIGNER_REF, "ref defaults");
  assert.equal(DEFAULT_RECEIPT_SIGNER_REF, "escrow-keeper");
  const named = receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: OPERATOR.seedHex,
    [RECEIPT_SIGNER_REF_ENV]: "ops-room-1" });
  assert.equal(named.ref, "ops-room-1", "explicit ref wins");
  const blankRef = receiptSignerFromEnv({ [RECEIPT_SIGNER_SEED_ENV]: OPERATOR.seedHex,
    [RECEIPT_SIGNER_REF_ENV]: "  " });
  assert.equal(blankRef.ref, DEFAULT_RECEIPT_SIGNER_REF, "blank ref falls back to the default");
});

// --- escrow integration ------------------------------------------------------------

const ROOM = "room-test";
const JILL = "id:agent/jill";         // poster lane
const GROK = "id:agent/grokbot";      // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";       // challenger lane

let nowMs = 1_786_100_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow({ signed } = {}, db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const opts = { now: () => nowMs, allowLegacyStringLanes: true };
  if (signed) opts.receipts = createReceiptSigner({ seedHex: OPERATOR.seedHex, ref: "test-operator" });
  const escrow = new BountyEscrow(store, opts);
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const journalOf = db => ({ entryHash: id =>
  db.prepare("SELECT hash FROM bounty_journal WHERE entry_id=?").get(id)?.hash ?? null });

function expectPairVerifies(db, decision, outcome, consumed = new Set()) {
  assert.ok(decision && decision.decisionId, "expected a decision receipt");
  assert.ok(outcome && outcome.receiptId, "expected an outcome receipt");
  assert.equal(outcome.payload.decisionId, decision.decisionId, "outcome binds the decision id");
  assert.equal(outcome.payload.decisionDigest, decisionDigest(decision), "outcome binds the decision digest");
  const v = verifyDecisionOutcomePair(decision, outcome,
    { expectedPubkey: OPERATOR.pubkeyHex, consumed, journal: journalOf(db) });
  assert.equal(v.ok, true, `keeper pair failed verification: ${JSON.stringify(v)}`);
  return v;
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 5, deadline: isoFuture(3_600_000), ...overrides }).bounty;

test("keeper path: fund issues a bound decision + outcome pair that verifies end to end", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = post(escrow);
  const { receipt } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  assert.equal(receipt.signed.length, 1);
  const [outcome] = receipt.signed;
  assert.equal(outcome.type, "escrow-locked");
  // The decision authorised exactly this movement, before it executed.
  assert.equal(receipt.decision.act, "escrow-locked");
  assert.equal(receipt.decision.target.roomId, ROOM);
  assert.equal(receipt.decision.target.bountyId, bounty.bountyId);
  assert.equal(receipt.decision.target.lotId, outcome.lotId);
  assert.equal(receipt.decision.amountMillis, outcome.amountMillis);
  assert.equal(receipt.decision.issuer.pubkey, OPERATOR.pubkeyHex);
  expectPairVerifies(db, receipt.decision, outcome);
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
});

test("keeper path: claim, accept, and dispute-settle movements each issue verifiable pairs", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const consumed = new Set();
  const bounty = post(escrow, { verifierId: INSTINCT });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const { receipt: claimReceipt } = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  expectPairVerifies(db, claimReceipt.decision, claimReceipt.signed[0], consumed);
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const { receipt: acceptReceipt } = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  expectPairVerifies(db, acceptReceipt.decision, acceptReceipt.signed[0], consumed);
  // Dispute settlement collects decisions the same way it collects receipts.
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 1.25, grounds: "plagiarized" });
  const { receipt: settleReceipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(settleReceipt.signed.length, 1);
  assert.ok(Array.isArray(settleReceipt.decisions), "settlement surfaces its decisions");
  assert.equal(settleReceipt.decisions.length, settleReceipt.signed.length);
  expectPairVerifies(db, settleReceipt.decisions[0], settleReceipt.signed[0], consumed);
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
});

test("inert default: an unarmed escrow returns signed: [] and NO decision key, byte-for-byte the old shape", () => {
  const { escrow } = makeEscrow(); // no signer
  const bounty = post(escrow);
  const { receipt } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  assert.deepEqual(receipt.signed, []);
  assert.equal("decision" in receipt, false, "unarmed transitions must not gain a decision key");
  const { receipt: claimReceipt } = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  assert.deepEqual(claimReceipt.signed, []);
  assert.equal("decision" in claimReceipt, false);
  tick(1); // keep the shared clock monotonic for later tests
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
});
