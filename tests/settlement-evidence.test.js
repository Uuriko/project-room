// Tests for server/settlement-evidence.mjs — the settlement-evidence/1
// credential that binds a bounty movement chain, the evaluator's signed
// verdict, and the recorded settlement into one third-party-verifiable
// bundle. Pure codec + BountyEscrow integration. Fail-first: this file was
// written before the module existed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  generateReceiptKeyPair,
  createReceiptSigner,
  issueBountyReceipt,
  signBytes,
} from "../server/bounty-receipts.mjs";
import {
  SETTLEMENT_EVIDENCE_VERSION,
  issueSettlementEvidence,
  signVerdict,
  verifySettlementEvidence,
} from "../server/settlement-evidence.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const sha256hex = s => createHash("sha256").update(s, "utf8").digest("hex");
const hex16 = () => randomBytes(8).toString("hex");

// --- fixtures ---------------------------------------------------------------
const OPERATOR = generateReceiptKeyPair();   // escrow-keeper (operator)
const EVALUATOR = generateReceiptKeyPair();  // the judge (independent lane key)
const ROOM = "room-test";
const BOUNTY = "ROOM-1";
const ISSUED_AT = "2026-10-07T12:00:00.000Z";
const ATTESTED_AT = "2026-10-07T11:59:00.000Z";
const SETTLED_AT = "2026-10-07T11:59:30.000Z";
const ACTOR = { kind: "agent", id: "id:agent/jill" };
const ISSUER = { pubkey: OPERATOR.pubkeyHex, role: "escrow-keeper", ref: "test-operator" };
const ENTRIES = ["ent_aaaaaaaaaaaaaaaa", "ent_bbbbbbbbbbbbbbbb"];
const ENTRY_HASHES = [sha256hex("entry-a"), sha256hex("entry-b")];
const RUBRIC_HASH = sha256hex("rubric v3: c1 must pass");
const DELIVERABLE_HASH = sha256hex("the deliverable bytes");

const receiptArgs = { roomId: ROOM, bountyId: BOUNTY, actor: ACTOR, issuer: ISSUER,
  issuedAt: ISSUED_AT, seedHex: OPERATOR.seedHex };

function escrowLockedReceipt({ amountMillis = "5000", lotId = `lot_${hex16()}` } = {}) {
  return issueBountyReceipt({ ...receiptArgs, type: "escrow-locked", lotId, amountMillis,
    entries: ENTRIES, entryHashes: ENTRY_HASHES,
    payload: { fromAccount: "id:agent/jill", fromLotState: "payable" } });
}

function attributedReceipt({ amountMillis = "5000", lotId = `lot_${hex16()}` } = {}) {
  return issueBountyReceipt({ ...receiptArgs, type: "attributed", lotId, amountMillis,
    entries: ENTRIES, entryHashes: ENTRY_HASHES,
    payload: { claimant: "id:agent/grokbot", eventSeq: "42" } });
}

function payoutReceipt({ net = "4950", fee = "50", gross = "5000" } = {}) {
  return issueBountyReceipt({ ...receiptArgs, type: "payout-released", lotId: `lot_${hex16()}`,
    amountMillis: net, entries: ENTRIES, entryHashes: ENTRY_HASHES,
    payload: { netAmountMillis: net, feeAmountMillis: fee, grossAmountMillis: gross,
      paidTo: "id:agent/grokbot", poolAccount: "pool:room" } });
}

function refundReceipt({ amountMillis = "5000", reason = "verification-rejected" } = {}) {
  return issueBountyReceipt({ ...receiptArgs, type: "refund-issued", lotId: `lot_${hex16()}`,
    amountMillis, entries: ENTRIES, entryHashes: ENTRY_HASHES,
    payload: { reason, refundTo: "id:agent/jill" } });
}

const verdictFields = (overrides = {}) => ({
  evaluator: { kind: "agent", id: "id:agent/instinct", pubkey: EVALUATOR.pubkeyHex },
  decision: "approved",
  citations: [{ criterionId: "c1", verdict: "pass" }],
  rubricVersion: "3",
  rubricHash: RUBRIC_HASH,
  deliverableSha256: DELIVERABLE_HASH,
  attestedAt: ATTESTED_AT,
  independence: "independent",
  ...overrides,
});

const settlementFields = (overrides = {}) => ({
  kind: "verified-complete",
  workerMillis: "5000",
  refundMillis: "0",
  reason: "work accepted against rubric v3",
  settledAt: SETTLED_AT,
  ...overrides,
});

function bundle({ receipts = [escrowLockedReceipt(), attributedReceipt()],
    verdict = signVerdict(verdictFields(), EVALUATOR.seedHex),
    settlement = settlementFields(), issuedAt = ISSUED_AT } = {}) {
  return issueSettlementEvidence({ receipts, verdict, settlement, issuer: ISSUER, issuedAt,
    seedHex: OPERATOR.seedHex });
}

const expectInvalid = (b, frag) => {
  const v = verifySettlementEvidence(b);
  assert.equal(v.ok, false, `expected invalid bundle, got ${JSON.stringify(v)}`);
  assert.match(v.reason, new RegExp(frag), `reason ${JSON.stringify(v.reason)} missing ${frag}`);
  return v;
};

// Bundles are frozen at issue time; tamper tests mutate a deep clone.
const clone = b => JSON.parse(JSON.stringify(b));

// issueSettlementEvidence / signVerdict fail fast like issueBountyReceipt:
// invalid inputs throw EvidenceError at issue time, never a bad bundle.
const expectIssueThrows = (fn, frag) => {
  assert.throws(fn, err => err.name === "EvidenceError" && new RegExp(frag).test(err.message),
    `expected EvidenceError matching ${frag}`);
};

// --- Part A: issue/verify round-trip ----------------------------------------
test("issue/verify round-trip: attributed chain verifies as a stranger", () => {
  const b = bundle();
  assert.equal(b.schemaVersion, SETTLEMENT_EVIDENCE_VERSION);
  assert.match(b.evidenceId, /^settlement-evidence:[0-9a-f]{32}$/);
  const v = verifySettlementEvidence(b, {
    expectedOperatorKey: OPERATOR.pubkeyHex,
    expectedEvaluatorKey: EVALUATOR.pubkeyHex,
  });
  assert.equal(v.ok, true, `verify failed: ${JSON.stringify(v)}`);
  assert.equal(v.evidenceId, b.evidenceId);
  assert.deepEqual(v.receiptIds, b.receipts.map(r => r.receiptId));
});

test("payout chain: payout-released terminal links workerMillis to netAmountMillis", () => {
  const receipts = [escrowLockedReceipt(), attributedReceipt(), payoutReceipt()];
  const b = bundle({ receipts,
    settlement: settlementFields({ workerMillis: "4950" }) });
  const v = verifySettlementEvidence(b, { expectedOperatorKey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, true, `verify failed: ${JSON.stringify(v)}`);
});

test("refund chain: refund-issued terminal requires failed/unverified kind and zero worker leg", () => {
  const receipts = [escrowLockedReceipt(), refundReceipt()];
  const b = bundle({ receipts,
    verdict: signVerdict(verdictFields({ decision: "rejected",
      citations: [{ criterionId: "c1", verdict: "fail" }] }), EVALUATOR.seedHex),
    settlement: settlementFields({ kind: "failed", workerMillis: "0",
      refundMillis: "5000", reason: "work judged bad" }) });
  const v = verifySettlementEvidence(b, { expectedOperatorKey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, true, `verify failed: ${JSON.stringify(v)}`);
});

test("bundle accepts its JSON text (strict parse); duplicate keys rejected", () => {
  const b = bundle();
  const text = JSON.stringify(b);
  const v = verifySettlementEvidence(text, { expectedOperatorKey: OPERATOR.pubkeyHex });
  assert.equal(v.ok, true, `text verify failed: ${JSON.stringify(v)}`);
  const dup = text.replace('"evidenceId"', '"evidenceId":"dup","evidenceId"');
  expectInvalid(dup, "duplicate");
});

test("JSON numbers are banned anywhere in the bundle", () => {
  const b = bundle();
  const text = JSON.stringify(b).replace('"workerMillis":"5000"', '"workerMillis":5000');
  expectInvalid(text, "number_ban");
});

// --- Part A: shape tampering --------------------------------------------------
test("unknown top-level key is rejected (no silent field repurposing)", () => {
  const b = clone(bundle()); b.extra = "nope";
  expectInvalid(b, "invalid_evidence");
});

test("wrong schemaVersion is rejected", () => {
  const b = clone(bundle()); b.schemaVersion = "settlement-evidence/2";
  expectInvalid(b, "schemaVersion");
});

test("operator signature tamper is rejected", () => {
  const b = clone(bundle());
  b.signature = "f".repeat(128);
  expectInvalid(b, "bad_signature");
});

test("valid signature under the wrong operator key fails closed", () => {
  const other = generateReceiptKeyPair();
  const b = bundle();
  const v = verifySettlementEvidence(b, { expectedOperatorKey: other.pubkeyHex });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected_signer/);
});

test("malformed evidenceId / timestamps rejected", () => {
  const b1 = clone(bundle()); b1.evidenceId = "nope";
  expectInvalid(b1, "evidenceId");
  const b2 = clone(bundle()); b2.issuedAt = "2026-10-07 12:00:00";
  expectInvalid(b2, "issuedAt");
});

// --- Part A: verdict tampering -------------------------------------------------
test("evaluator signature tamper is rejected", () => {
  const v0 = clone(signVerdict(verdictFields(), EVALUATOR.seedHex));
  v0.signature = "0".repeat(128);
  expectInvalid(bundle({ verdict: v0 }), "bad_verdict_signature");
});

test("verdict signed by someone else fails closed under expectedEvaluatorKey", () => {
  const other = generateReceiptKeyPair();
  const v0 = signVerdict(
    verdictFields({ evaluator: { kind: "agent", id: "id:agent/mallory", pubkey: other.pubkeyHex } }),
    other.seedHex);
  const b = bundle({ verdict: v0 });
  // Passes without a binding ("someone signed this") ...
  assert.equal(verifySettlementEvidence(b).ok, true);
  // ... fails closed when the stranger pins the expected evaluator key.
  const v = verifySettlementEvidence(b, { expectedEvaluatorKey: EVALUATOR.pubkeyHex });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected_evaluator/);
});

test("decision must cohere with citations: approved with a fail is rejected", () => {
  expectIssueThrows(() => signVerdict(verdictFields({ decision: "approved",
    citations: [{ criterionId: "c1", verdict: "fail" }] }), EVALUATOR.seedHex), "incoherent");
});

test("decision must cohere with citations: rejected with all-pass is rejected", () => {
  expectIssueThrows(() => signVerdict(verdictFields({ decision: "rejected",
    citations: [{ criterionId: "c1", verdict: "pass" }] }), EVALUATOR.seedHex), "incoherent");
});

test("duplicate criterionIds / empty citations / bad rubric hash rejected", () => {
  expectIssueThrows(() => signVerdict(verdictFields({ citations: [
    { criterionId: "c1", verdict: "pass" }, { criterionId: "c1", verdict: "pass" }] }),
    EVALUATOR.seedHex), "duplicate");
  expectIssueThrows(() => signVerdict(verdictFields({ citations: [] }), EVALUATOR.seedHex),
    "citations");
  expectIssueThrows(() => signVerdict(verdictFields({ rubricHash: "zz" }), EVALUATOR.seedHex),
    "rubricHash");
});

test("attestedAt after issuedAt is rejected (verdict must precede the bundle)", () => {
  const v0 = signVerdict(verdictFields({ attestedAt: "2026-10-08T00:00:00Z" }), EVALUATOR.seedHex);
  expectIssueThrows(() => bundle({ verdict: v0 }), "attestedAt");
});

test("self-judged verdicts are recorded honestly, not hidden", () => {
  const v0 = signVerdict(verdictFields({ independence: "self" }), EVALUATOR.seedHex);
  const v = verifySettlementEvidence(bundle({ verdict: v0 }));
  assert.equal(v.ok, true, `self verdict should verify: ${JSON.stringify(v)}`);
  assert.equal(v.independence, "self");
});

test("null deliverableSha256 verifies (unverifiable content, not failure)", () => {
  const v0 = signVerdict(verdictFields({ deliverableSha256: null }), EVALUATOR.seedHex);
  const v = verifySettlementEvidence(bundle({ verdict: v0 }));
  assert.equal(v.ok, true, `null deliverable should verify: ${JSON.stringify(v)}`);
});

// --- Part A: settlement coherence ----------------------------------------------
test("unknown settlement kind is rejected", () => {
  expectIssueThrows(() => bundle({ settlement: settlementFields({ kind: "moon" }) }), "kind");
});

test("settledAt after issuedAt is rejected", () => {
  expectIssueThrows(() => bundle({ settlement: settlementFields({ settledAt: "2026-10-08T00:00:00Z" }) }),
    "settledAt");
});

test("terminal-type/kind mismatch is rejected (payout receipt + failed kind)", () => {
  const receipts = [escrowLockedReceipt(), payoutReceipt()];
  expectIssueThrows(() => bundle({ receipts,
    settlement: settlementFields({ kind: "failed", workerMillis: "0", refundMillis: "5000" }) }),
    "inconsistent");
});

test("amount linkage: workerMillis must equal the terminal movement amount", () => {
  expectIssueThrows(() => bundle({ settlement: settlementFields({ workerMillis: "4999" }) }),
    "workerMillis");
});

test("refund terminal requires workerMillis zero", () => {
  const receipts = [escrowLockedReceipt(), refundReceipt()];
  const v0 = signVerdict(verdictFields({ decision: "rejected",
    citations: [{ criterionId: "c1", verdict: "fail" }] }), EVALUATOR.seedHex);
  expectIssueThrows(() => bundle({ receipts, verdict: v0,
    settlement: settlementFields({ kind: "failed", workerMillis: "1",
      refundMillis: "4999", reason: "x" }) }), "workerMillis");
});

// --- Part A: receipt chain -------------------------------------------------------
test("empty receipts array is rejected", () => {
  expectIssueThrows(() => bundle({ receipts: [] }), "receipts");
});

test("chain must start with escrow-locked (funding first)", () => {
  expectIssueThrows(() => bundle({ receipts: [attributedReceipt()] }), "escrow-locked");
});

test("receipt from a different bounty is rejected", () => {
  const other = clone(escrowLockedReceipt());
  other.bountyId = "ROOM-2";
  expectIssueThrows(() => bundle({ receipts: [other, attributedReceipt()] }), "bountyId");
});

test("tampered wrapped receipt fails the bundle at the receipt check", () => {
  // Issue a valid bundle, tamper one wrapped receipt, then re-sign the bundle
  // with the operator key so the operator signature stays valid and the
  // receipt-level check is what catches the tamper.
  const t = clone(bundle());
  t.receipts[1].signature = "0".repeat(128); // well-formed hex, wrong signature
  const unsigned = { ...t };
  delete unsigned.signature;
  t.signature = signBytes(canonicalJson(unsigned), OPERATOR.seedHex);
  const v = verifySettlementEvidence(t);
  assert.equal(v.ok, false, `expected invalid, got ${JSON.stringify(v)}`);
  assert.match(v.reason, /receipt\[1\]: bad_signature/);
});

test("replay: verifying twice with the same seen-set rejects the duplicate", () => {
  const b = bundle();
  const seen = new Set();
  assert.equal(verifySettlementEvidence(b, { seen }).ok, true);
  const v = verifySettlementEvidence(b, { seen });
  assert.equal(v.ok, false);
  assert.match(v.reason, /duplicate/);
});

// --- Part B: escrow integration ---------------------------------------------------
// Drives a real BountyEscrow fund -> claim -> submit -> acceptWork, builds the
// evaluator-signed verdict from the recorded bounty.attestation, wraps the
// issued receipts, and verifies the bundle as a stranger (fresh keys only,
// no server state).

const JILL = "id:agent/jill";        // poster
const GROK = "id:agent/grokbot";     // worker
const INSTINCT = "id:agent/instinct"; // verifier
let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, {
    now: () => nowMs,
    allowLegacyStringLanes: true,
    receipts: createReceiptSigner({ seedHex: OPERATOR.seedHex, ref: "test-operator" }),
  });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

test("end to end: real escrow flow -> evaluator-signed verdict -> stranger verification", () => {
  const { escrow, db } = makeEscrow();
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C",
    amount: 5, deadline: new Date(nowMs + 3_600_000).toISOString() }).bounty;
  const funded = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  tick(1000);
  const accepted = escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  tick(1000);

  const receipts = [...funded.receipt.signed, ...accepted.receipt.signed];
  assert.ok(receipts.length >= 2, "expected funding + attribution receipts");
  assert.equal(receipts[0].type, "escrow-locked");
  assert.equal(receipts[receipts.length - 1].type, "attributed");

  // The evaluator signs their verdict from the recorded attestation.
  const recorded = escrow.getBounty(ROOM, bounty.bountyId).attestation;
  assert.ok(recorded && recorded.citations, "attestation recorded");
  const verdict = signVerdict({
    evaluator: { kind: "agent", id: INSTINCT, pubkey: EVALUATOR.pubkeyHex },
    decision: "approved",
    citations: recorded.citations.map(c => ({ criterionId: c.criterionId, verdict: c.verdict })),
    rubricVersion: String(recorded.rubricVersion), // escrow stores a number; the credential bans numbers
    rubricHash: recorded.rubricHash,
    deliverableSha256: null, // submitWork records no content hash yet (follow-up)
    attestedAt: recorded.recordedAt,
    independence: "independent",
  }, EVALUATOR.seedHex);

  const issuedAt = new Date(nowMs).toISOString();
  const bundleDoc = issueSettlementEvidence({
    receipts,
    verdict,
    settlement: {
      kind: "verified-complete",
      workerMillis: receipts[receipts.length - 1].amountMillis,
      refundMillis: "0",
      reason: "work accepted against pinned rubric",
      settledAt: new Date(nowMs - 500).toISOString(),
    },
    issuer: ISSUER,
    issuedAt,
    seedHex: OPERATOR.seedHex,
  });

  // The stranger: only the bundle text + the two pinned public keys.
  const journal = { entryHash: id =>
    db.prepare("SELECT hash FROM bounty_journal WHERE entry_id=?").get(id)?.hash ?? null };
  const seen = new Set();
  const v = verifySettlementEvidence(JSON.parse(JSON.stringify(bundleDoc)), {
    expectedOperatorKey: OPERATOR.pubkeyHex,
    expectedEvaluatorKey: EVALUATOR.pubkeyHex,
    journal,
    seen,
  });
  assert.equal(v.ok, true, `stranger verification failed: ${JSON.stringify(v)}`);
  assert.equal(v.decision, "approved");
  assert.equal(v.settlementKind, "verified-complete");
  // Conservation still holds on the ledger underneath.
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});
