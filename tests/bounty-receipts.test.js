// Tests for server/bounty-receipts.mjs and its BountyEscrow integration.
//
// Part A: the pure codec — canonical encoding is BYTE-IDENTICAL to the
// dasha-receipt/1 Python reference (vectors copied from
// ~/workspace/dasha-receipts/.tmp/{canonical,ed25519}-vectors.json,
// generated 2026-09-22), and issue/verify round-trips reject every
// tamper class.
// Part B: the escrow integration — every value-moving transition issues a
// signed receipt (or `signed: []` with no signer), the ledger still
// conserves, and receipts verify against the journal.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_TYPES,
  canonicalJson,
  parseStrict,
  importSeed,
  importPubkey,
  generateReceiptKeyPair,
  createReceiptSigner,
  signBytes,
  verifyBytes,
  issueBountyReceipt,
  verifyBountyReceipt,
  ReceiptError,
  CREDIT_UNIT,
} from "../server/bounty-receipts.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

// --- reference vectors (dasha-receipt/1 Python implementation) ----------------
const CANONICAL_VECTORS = [
  { input: {"z": "1", "a": "2", "é": "3"},
    canonical: "{\"a\":\"2\",\"z\":\"1\",\"é\":\"3\"}" },
  { input: {"key": "quote \" backslash \\ slash / newline \n tab \t ctrl \u0001"},
    canonical: "{\"key\":\"quote \\\" backslash \\\\ slash / newline \\n tab \\t ctrl \\u0001\"}" },
  { input: {"emoji": "☕", "plain": "é"},
    canonical: "{\"emoji\":\"☕\",\"plain\":\"é\"}" },
  { input: {"𝄞": "g-clef", "z": "z", "é": "e-acute"},
    canonical: "{\"z\":\"z\",\"é\":\"e-acute\",\"𝄞\":\"g-clef\"}" },
  { input: {"nested": {"b": ["x", true, null], "a": {"y": "deep"}}},
    canonical: "{\"nested\":{\"a\":{\"y\":\"deep\"},\"b\":[\"x\",true,null]}}" },
  { input: {"arr": [{"k2": "v", "k1": "w"}, []]},
    canonical: "{\"arr\":[{\"k1\":\"w\",\"k2\":\"v\"},[]]}" },
  { input: {"empty_obj": {}, "empty_arr": [], "empty_str": ""},
    canonical: "{\"empty_arr\":[],\"empty_obj\":{},\"empty_str\":\"\"}" },
  { input: {"mixed_keys": {"A": "1", "a": "2", "0": "3", "_": "4", "ÿ": "5", "😀": "6"}},
    canonical: "{\"mixed_keys\":{\"0\":\"3\",\"A\":\"1\",\"_\":\"4\",\"a\":\"2\",\"ÿ\":\"5\",\"😀\":\"6\"}}" },
];
const ED25519_VECTORS = [
  { seed: '9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60', pubkey: 'b9ce0f24f866c0fa02ab7c1ff345f9bb7c73205b4c2ec76a77295ef16592dc0d',
    messageHex: '7b22726563656970744964223a22726f6f6d2d626f756e74792d726563656970743a70723a396632633431616137376265303064316338663265393161343462643730306161222c22736368656d6156657273696f6e223a22726f6f6d2d626f756e74792d726563656970742f31227d',
    signature: 'b5a7a1bd387fb7c38a8c3110f09f2547fcb40a2d51b24bb07835c6a4e161a341e78e28b0c1dd4cc3f37cad7d34f08226ba2514453afef565bd4ca7155ae5a100' },
  { seed: '9d61b19deffd5a60ba844af492ec2af44449c5697b326919703bac031cae7f60', pubkey: 'b9ce0f24f866c0fa02ab7c1ff345f9bb7c73205b4c2ec76a77295ef16592dc0d',
    messageHex: '7b2261223a2278222c2262223a5b2279222c747275652c6e756c6c5d2c2263223a7b226e6573746564223a22e29895227d7d',
    signature: 'ec168d11d82e3521b9866256af5657dd59324aa926815048ed2ccda66409b3dcb4662f6ade95039bd178332cffa331ddfd74ef32cd9433024d10caa877ee6e00' },
];

// The operator test key: the SAME seed as the Python reference vectors, so
// the whole chain (derive -> sign -> verify) is pinned to the reference.
const TEST_SEED = ED25519_VECTORS[0].seed;
const TEST_PUBKEY = ED25519_VECTORS[0].pubkey;
const signer = () => createReceiptSigner({ seedHex: TEST_SEED, ref: "test-operator" });

const ISSUED_AT = "2026-09-22T12:00:00.000Z";
const ACTOR = { kind: "agent", id: "id:agent/jill" };
const ENTRIES = ["ent_aaaaaaaaaaaaaaaa", "ent_bbbbbbbbbbbbbbbb"];
const HASHES = ["a".repeat(64), "b".repeat(64)];

function issueArgs(type, payload, overrides = {}) {
  return { type, roomId: "room-test", bountyId: "ROOM-1", lotId: "lot_cccccccccccccccc", amountMillis: "10000",
    actor: ACTOR, entries: ENTRIES, entryHashes: HASHES, payload,
    issuer: { pubkey: TEST_PUBKEY, role: "escrow-keeper", ref: "test-operator" },
    issuedAt: ISSUED_AT, seedHex: TEST_SEED, ...overrides };
}

const PAYLOADS = {
  "escrow-locked": { fromAccount: "id:agent/jill", fromLotState: "payable" },
  "bond-locked": { bondKind: "claim", fromAccount: "id:agent/grokbot" },
  "attributed": { claimant: "id:agent/grokbot", eventSeq: "7" },
  "payout-released": { netAmountMillis: "9900", feeAmountMillis: "100", grossAmountMillis: "10000", paidTo: "id:agent/grokbot", poolAccount: "pool" },
  "refund-issued": { reason: "timeout", refundTo: "id:agent/jill" },
};

// --- Part A: canonical encoding ------------------------------------------------

test("canonical encoding matches the Python reference vectors byte-for-byte", () => {
  assert.equal(CANONICAL_VECTORS.length, 8, "all eight reference vectors present");
  for (const { input, canonical } of CANONICAL_VECTORS) {
    const bytes = canonicalJson(input);
    assert.ok(Buffer.isBuffer(bytes), "canonicalJson returns a Buffer");
    assert.equal(bytes.toString("utf8"), canonical, `vector mismatch: ${JSON.stringify(input)}`);
    assert.deepEqual([...bytes], [...Buffer.from(canonical, "utf8")], "byte-exact");
  }
});

test("canonicalJson rejects JSON numbers anywhere in signed bodies", () => {
  for (const bad of [{ a: 1 }, { a: { b: [1] } }, [1], { a: "1", b: 2 }]) {
    assert.throws(() => canonicalJson(bad), /number_ban|forbidden/i, `number accepted: ${JSON.stringify(bad)}`);
  }
  // Decimal strings are the legal spelling of amounts.
  assert.equal(canonicalJson({ amountMillis: "10000" }).toString("utf8"), '{"amountMillis":"10000"}');
});

test("parseStrict rejects duplicate object keys and lone surrogates", () => {
  assert.throws(() => parseStrict('{"a":"1","a":"2"}'), /duplicate object key/);
  assert.throws(() => parseStrict('{"a":"\\ud834"}'), /lone high surrogate/);
  assert.throws(() => parseStrict('{"a":"\\udcff"}'), /lone low surrogate/);
  assert.throws(() => parseStrict('{"a":}'), /invalid JSON/);
  assert.throws(() => parseStrict('{"a":"1"} trailing'), /trailing/);
  assert.deepEqual(parseStrict('{"b":1,"a":[true,null]}'), { b: 1, a: [true, null] });
  // Numbers survive the parse as JS numbers so the number ban can reject them.
  assert.equal(typeof parseStrict('{"n":42}').n, "number");
});

// --- Part A: Ed25519 ------------------------------------------------------------

test("signer derives the reference pubkey; signBytes reproduces the reference signatures", () => {
  const s = signer();
  assert.equal(s.pubkeyHex, TEST_PUBKEY, "derived pubkey matches the Python reference");
  assert.equal(s.ref, "test-operator");
  for (const v of ED25519_VECTORS) {
    assert.equal(signBytes(Buffer.from(v.messageHex, "hex"), v.seed), v.signature,
      "node signature is byte-identical to the Python reference signature");
    assert.ok(verifyBytes(Buffer.from(v.messageHex, "hex"), v.signature, v.pubkey), "reference signature verifies");
  }
  assert.ok(importSeed(TEST_SEED), "seed import works");
  assert.ok(importPubkey(TEST_PUBKEY), "pubkey import works");
  assert.throws(() => importSeed("zz"), ReceiptError);
  assert.throws(() => createReceiptSigner({ seedHex: TEST_SEED, ref: "" }), ReceiptError);
});

test("generateReceiptKeyPair produces valid test keys", () => {
  const { seedHex, pubkeyHex } = generateReceiptKeyPair();
  assert.match(seedHex, /^[0-9a-f]{64}$/);
  assert.match(pubkeyHex, /^[0-9a-f]{64}$/);
  const s = createReceiptSigner({ seedHex, ref: "ephemeral" });
  assert.equal(s.pubkeyHex, pubkeyHex);
});

// --- Part A: issue / verify ------------------------------------------------------

test("issue + verify round-trips for all five receipt types", () => {
  for (const type of Object.keys(RECEIPT_TYPES)) {
    // payout-released attests the net payout movement: amount == net.
    const amount = type === "payout-released" ? "9900" : "10000";
    const r = issueBountyReceipt(issueArgs(type, PAYLOADS[type], { amountMillis: amount }));
    assert.equal(r.schemaVersion, RECEIPT_SCHEMA_VERSION);
    assert.equal(r.type, type);
    assert.ok(r.receiptId.startsWith(`room-bounty-receipt:${RECEIPT_TYPES[type]}:`), `short matches type: ${r.receiptId}`);
    assert.match(r.receiptId, /^room-bounty-receipt:[a-z]{2}:[0-9a-f]{32}$/);
    assert.equal(r.amountMillis, amount); // decimal string, never a JSON number
    assert.equal(r.roomId, "room-test", "receipt is bound to the issuing room");
    assert.equal(r.creditUnit, CREDIT_UNIT, "credits-only unit is self-describing");
    assert.equal(CREDIT_UNIT, "milli-credit");
    assert.match(r.signature, /^[0-9a-f]{128}$/);
    const v = verifyBountyReceipt(r, { expectedPubkey: TEST_PUBKEY });
    assert.equal(v.ok, true, `verify failed for ${type}: ${JSON.stringify(v)}`);
    assert.equal(v.receiptId, r.receiptId);
    assert.equal(v.signer, TEST_PUBKEY);
    // The JSON-text path parses strictly and verifies identically.
    const v2 = verifyBountyReceipt(JSON.stringify(r), { expectedPubkey: TEST_PUBKEY });
    assert.equal(v2.ok, true, `text-path verify failed for ${type}`);
    // Two issues never share a receiptId.
    const r2 = issueBountyReceipt(issueArgs(type, PAYLOADS[type], { amountMillis: amount }));
    assert.notEqual(r2.receiptId, r.receiptId);
  }
});

test("verify rejects every tamper class", () => {
  const base = issueBountyReceipt(issueArgs("payout-released", PAYLOADS["payout-released"], { amountMillis: "9900" }));
  const tamper = (mut, reason) => {
    const copy = JSON.parse(JSON.stringify(base));
    mut(copy);
    const v = verifyBountyReceipt(copy, { expectedPubkey: TEST_PUBKEY });
    assert.equal(v.ok, false, `tamper accepted: ${reason}`);
    return v.reason;
  };
  assert.match(tamper(r => { r.amountMillis = "9999"; }, "amount"), /invalid_receipt/); // net==amount shape check fires first
  assert.match(tamper(r => { r.lotId = "lot_dddddddddddddddd"; }, "lot"), /bad_signature/);
  assert.match(tamper(r => { r.bountyId = "ROOM-2"; }, "bounty"), /bad_signature/);
  assert.match(tamper(r => { r.actor.id = "id:agent/mallory"; }, "actor"), /bad_signature/);
  assert.match(tamper(r => { r.payload.entryHashes[0] = "c".repeat(64); }, "entry hash"), /bad_signature/);
  assert.match(tamper(r => { r.payload.netAmountMillis = "9901"; }, "net != amount"), /invalid_receipt/); // shape checked before signature
  assert.match(tamper(r => { r.type = "refund-issued"; }, "type"), /invalid_receipt/); // short no longer matches
  assert.match(tamper(r => { r.issuer.pubkey = "d".repeat(64); }, "issuer key"), /bad_signature/);
  assert.match(tamper(r => { r.signature = r.signature.slice(0, 127) + (r.signature[127] === "0" ? "1" : "0"); }, "signature bit"), /bad_signature/);
  assert.match(tamper(r => { r.signature = "e".repeat(128); }, "signature wholesale"), /bad_signature/);
  assert.match(tamper(r => { r.extra = "x"; }, "unknown field"), /invalid_receipt/);
  assert.match(tamper(r => { delete r.payload.feeAmountMillis; }, "missing field"), /invalid_receipt/);
  assert.match(tamper(r => { r.issuedAt = "2026-13-45T99:99:99Z"; }, "impossible time"), /invalid_receipt/);
  // A JSON number smuggled through the text path is rejected before signature checking.
  const numbered = JSON.stringify(base).replace('"amountMillis":"9900"', '"amountMillis":9900');
  assert.match(verifyBountyReceipt(numbered).reason, /number_ban/);
  // Duplicate keys in the text are rejected at parse time.
  const dup = JSON.stringify(base).replace(/^{/, '{"type":"escrow-locked","type":"payout-released",');
  assert.match(verifyBountyReceipt(dup).reason, /duplicate object key/);
});

test("verify rejects a valid signature from the wrong key", () => {
  const other = generateReceiptKeyPair();
  const r = issueBountyReceipt(issueArgs("escrow-locked", PAYLOADS["escrow-locked"], { seedHex: other.seedHex,
    issuer: { pubkey: other.pubkeyHex, role: "escrow-keeper", ref: "someone-else" } }));
  // Internally consistent: verifies fine without an expected key...
  assert.equal(verifyBountyReceipt(r).ok, true);
  // ...but not against the operator key this context trusts.
  const v = verifyBountyReceipt(r, { expectedPubkey: TEST_PUBKEY });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected_signer/);
});

test("the seen-set gives replay protection on receiptIds", () => {
  const seen = new Set();
  const r1 = issueBountyReceipt(issueArgs("escrow-locked", PAYLOADS["escrow-locked"]));
  const r2 = issueBountyReceipt(issueArgs("escrow-locked", PAYLOADS["escrow-locked"]));
  assert.equal(verifyBountyReceipt(r1, { seen }).ok, true);
  assert.match(verifyBountyReceipt(r1, { seen }).reason, /duplicate_receipt/);
  assert.equal(verifyBountyReceipt(r2, { seen }).ok, true, "a distinct receiptId still verifies");
});

test("journal linkage binds the receipt to the ledger", () => {
  const r = issueBountyReceipt(issueArgs("attributed", PAYLOADS["attributed"]));
  const journal = { entryHash: id => ({ [ENTRIES[0]]: HASHES[0], [ENTRIES[1]]: HASHES[1] })[id] ?? null };
  assert.equal(verifyBountyReceipt(r, { journal }).ok, true);
  const tampered = { entryHash: id => (id === ENTRIES[0] ? "f".repeat(64) : journal.entryHash(id)) };
  assert.match(verifyBountyReceipt(r, { journal: tampered }).reason, /journal_mismatch/);
  const missing = { entryHash: () => { throw new Error("no such entry"); } };
  assert.match(verifyBountyReceipt(r, { journal: missing }).reason, /journal_mismatch/);
});

test("payout-released requires net == amount and net + fee == gross", () => {
  const base = issueArgs("payout-released",
    { netAmountMillis: "9900", feeAmountMillis: "100", grossAmountMillis: "10000", paidTo: "id:agent/grokbot", poolAccount: "pool" });
  // A well-formed receipt issues fine (amount "10000" would be the gross;
  // here amount is the net movement, so rebuild args with amount 9900).
  const okArgs = { ...base, amountMillis: "9900" };
  assert.equal(verifyBountyReceipt(issueBountyReceipt(okArgs)).ok, true);
  const badGross = { ...base, amountMillis: "9900",
    payload: { ...base.payload, grossAmountMillis: "9999" } };
  assert.throws(() => issueBountyReceipt(badGross), /netAmountMillis \+ feeAmountMillis must equal payload.grossAmountMillis/);
  const badNet = { ...base, amountMillis: "9900",
    payload: { ...base.payload, netAmountMillis: "9899" } };
  assert.throws(() => issueBountyReceipt(badNet), /netAmountMillis must equal the receipt amount/);
});

test("roomId binds the receipt to one room; creditUnit is enforced", () => {
  const a = issueBountyReceipt(issueArgs("escrow-locked", PAYLOADS["escrow-locked"], { roomId: "room-a" }));
  const b = issueBountyReceipt(issueArgs("escrow-locked", PAYLOADS["escrow-locked"], { roomId: "room-b" }));
  assert.notEqual(a.signature, b.signature, "roomId is inside the signed body");
  // Rewriting the roomId breaks the signature.
  const moved = { ...a, roomId: "room-b" };
  assert.equal(verifyBountyReceipt(moved, { expectedPubkey: TEST_PUBKEY }).ok, false);
  assert.match(verifyBountyReceipt(moved, { expectedPubkey: TEST_PUBKEY }).reason, /bad_signature/);
  // Omitting roomId fails shape validation; rewriting creditUnit fails too.
  assert.throws(() => issueBountyReceipt(issueArgs("escrow-locked", PAYLOADS["escrow-locked"], { roomId: "" })), /roomId/);
  const tampered = { ...a, creditUnit: "usd" };
  assert.match(verifyBountyReceipt(tampered, { expectedPubkey: TEST_PUBKEY }).reason, /creditUnit/);
});

test("receipts are credits-only: no chain, asset, wallet, or cash language anywhere", () => {
  const FORBIDDEN = /chain|asset|wallet|txhash|transaction|cash|usd|dollar|money|payment|cctp|x402|erc-?8004|merkle|bridge|settlement/i;
  for (const type of Object.keys(RECEIPT_TYPES)) {
    const amount = type === "payout-released" ? "9900" : "10000";
    const r = issueBountyReceipt(issueArgs(type, PAYLOADS[type], { amountMillis: amount }));
    const unsigned = { ...r };
    delete unsigned.signature;
    const text = canonicalJson(unsigned).toString("utf8");
    assert.ok(!FORBIDDEN.test(text), `forbidden monetary language in ${type}: ${text}`);
  }
  // The schema's own vocabulary is lots, milli-credits, and ledger states.
  const vocab = new Set();
  for (const type of Object.keys(RECEIPT_TYPES)) {
    const amount = type === "payout-released" ? "9900" : "10000";
    for (const k of Object.keys(issueBountyReceipt(issueArgs(type, PAYLOADS[type], { amountMillis: amount })))) vocab.add(k);
  }
  for (const word of ["chain", "asset", "wallet", "cash", "txHash"])
    assert.ok(!vocab.has(word), `schema must not contain ${word}`);
});

// --- Part B: escrow integration ---------------------------------------------------

const ROOM = "room-test";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // verifier lane
const CODEX = "id:agent/codex";    // challenger lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow({ signed } = {}, db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const opts = { now: () => nowMs };
  if (signed) opts.receipts = createReceiptSigner({ seedHex: TEST_SEED, ref: "test-operator" });
  const escrow = new BountyEscrow(store, opts);
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 5, deadline: isoFuture(3_600_000), ...overrides }).bounty;

function runToAccepted(escrow, { amount = 5, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

function runToSubmitted(escrow, { amount = 5, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// Verify one signed receipt against the live journal.
function expectVerifiable(db, receipt) {
  assert.ok(receipt && receipt.receiptId, "expected a signed receipt");
  const journal = { entryHash: id => db.prepare("SELECT hash FROM bounty_journal WHERE entry_id=?").get(id)?.hash ?? null };
  const v = verifyBountyReceipt(receipt, { expectedPubkey: TEST_PUBKEY, journal });
  assert.equal(v.ok, true, `receipt failed verification: ${JSON.stringify(v)} (${receipt.receiptId})`);
  return v;
}

test("fund issues a signed escrow-locked receipt stamped on both journal entries", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = post(escrow);
  const { receipt } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  assert.equal(receipt.signed.length, 1);
  const [r] = receipt.signed;
  assert.equal(r.type, "escrow-locked");
  assert.equal(r.bountyId, bounty.bountyId);
  assert.equal(r.amountMillis, String(5 * 1000));
  assert.equal(r.payload.fromAccount, JILL);
  assert.equal(r.payload.fromLotState, "payable");
  assert.deepEqual(r.payload.entries, receipt.entries);
  expectVerifiable(db, r);
  const rows = db.prepare("SELECT receipt_id FROM bounty_journal WHERE entry_id IN (?,?)")
    .all(receipt.entries[0], receipt.entries[1]);
  assert.ok(rows.every(row => row.receipt_id === r.receiptId), "both journal entries stamped");
  // history() surfaces the linkage.
  const h = escrow.history(ROOM, JILL).find(x => x.bountyId === bounty.bountyId && x.kind === "escrow-lock");
  assert.ok(h, "fund movement in history");
  assert.deepEqual(h.signedReceiptIds, [r.receiptId]);
  expectConserved(escrow);
});

test("claim and dispute lock signed bond-locked receipts with the bond kind", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = runToSubmitted(escrow, { verifier: INSTINCT });
  const bounty2 = post(escrow);
  escrow.fundBounty(ROOM, bounty2.bountyId, { funder: JILL });
  const { receipt: claim } = escrow.claimBounty(ROOM, bounty2.bountyId, { claimant: CODEX });
  assert.equal(claim.signed.length, 1);
  assert.equal(claim.signed[0].type, "bond-locked");
  assert.equal(claim.signed[0].payload.bondKind, "claim");
  expectVerifiable(db, claim.signed[0]);
  const { receipt: disputeReceipt } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: CODEX, bond: 1.25, grounds: "looks wrong" });
  assert.equal(disputeReceipt.signed.length, 1);
  assert.equal(disputeReceipt.signed[0].type, "bond-locked");
  assert.equal(disputeReceipt.signed[0].payload.bondKind, "dispute");
  expectVerifiable(db, disputeReceipt.signed[0]);
  expectConserved(escrow);
});

test("accept issues a signed attributed receipt linked to the approval event", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  const { receipt } = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  assert.equal(receipt.signed.length, 1);
  const [r] = receipt.signed;
  assert.equal(r.type, "attributed");
  assert.equal(r.payload.claimant, GROK);
  assert.equal(r.payload.eventSeq, String(receipt.event.seq), "attribution links the approval event");
  expectVerifiable(db, r);
  expectConserved(escrow);
});

test("timeout refund issues a signed refund-issued receipt (reason timeout)", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(3_600_000 + 1);
  const { action, receipt } = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: INSTINCT });
  assert.equal(action, "refunded");
  assert.equal(receipt.signed.length, 1);
  const [r] = receipt.signed;
  assert.equal(r.type, "refund-issued");
  assert.equal(r.payload.reason, "timeout");
  assert.equal(r.payload.refundTo, JILL);
  assert.equal(r.amountMillis, String(8 * 1000));
  expectVerifiable(db, r);
  expectConserved(escrow);
});

test("epoch sweep issues a signed payout-released receipt with net + fee == award", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = runToAccepted(escrow, { amount: 5 });
  tick(3 * 24 * 3_600_000 + 1); // challenge window passes
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK });
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  const signed = epoch.summary.signedReceipts?.[bounty.bountyId];
  assert.ok(signed && signed.length === 1, "sweep receipts surface in the epoch summary");
  const [r] = signed;
  assert.equal(r.type, "payout-released");
  assert.equal(r.payload.paidTo, GROK);
  assert.equal(r.payload.poolAccount, "pool");
  assert.equal(r.amountMillis, r.payload.netAmountMillis, "receipt amount is the net payout movement");
  assert.equal(BigInt(r.payload.netAmountMillis) + BigInt(r.payload.feeAmountMillis),
    BigInt(r.payload.grossAmountMillis), "net + fee equals the gross award");
  assert.equal(r.payload.grossAmountMillis, String(5 * 1000));
  expectVerifiable(db, r);
  expectConserved(escrow);
});

test("dispute cancel issues refund-issued (dispute-cancel); split issues attributed + refund-issued (split)", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  // CANCEL from a pre-accept dispute: the award is still locked, so it refunds.
  const bounty = runToSubmitted(escrow, { verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 1.25, grounds: "plagiarized" });
  const { receipt: cancelReceipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(cancelReceipt.signed.length, 1);
  assert.equal(cancelReceipt.signed[0].type, "refund-issued");
  assert.equal(cancelReceipt.signed[0].payload.reason, "dispute-cancel");
  assert.equal(cancelReceipt.signed[0].payload.refundTo, JILL);
  expectVerifiable(db, cancelReceipt.signed[0]);
  // SPLIT from a pre-accept dispute: half attributes to the worker, half refunds.
  const bounty2 = runToSubmitted(escrow, { verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty2.bountyId, { challenger: CODEX, bond: 1.25, grounds: "partial" });
  const { receipt: splitReceipt } = escrow.decideDispute(ROOM, bounty2.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(splitReceipt.signed.length, 2);
  const types = splitReceipt.signed.map(r => r.type).sort();
  assert.deepEqual(types, ["attributed", "refund-issued"]);
  const splitRefund = splitReceipt.signed.find(r => r.type === "refund-issued");
  assert.equal(splitRefund.payload.reason, "split");
  assert.equal(splitRefund.payload.refundTo, JILL);
  for (const r of splitReceipt.signed) expectVerifiable(db, r);
  expectConserved(escrow);
});

test("dispute release from pre-accept issues a signed attributed receipt", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = runToSubmitted(escrow, { verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 1.25, grounds: "looks wrong" });
  const { receipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(receipt.signed.length, 1);
  assert.equal(receipt.signed[0].type, "attributed");
  assert.equal(receipt.signed[0].payload.claimant, GROK);
  expectVerifiable(db, receipt.signed[0]);
  expectConserved(escrow);
});

test("without a signer, transitions return signed: [] and the ledger still conserves", () => {
  const { escrow, db } = makeEscrow(); // no `signed: true`
  const bounty = runToAccepted(escrow, { amount: 5 });
  const { receipt: fundReceipt } = escrow.fundBounty(ROOM, post(escrow).bountyId, { funder: JILL });
  assert.deepEqual(fundReceipt.signed, []);
  tick(3 * 24 * 3_600_000 + 1);
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK });
  assert.deepEqual(fin.receipt.signed, []);
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.equal(epoch.summary.signedReceipts, undefined);
  // No receipt_id stamps without a signer.
  const stamped = db.prepare("SELECT COUNT(*) AS n FROM bounty_journal WHERE receipt_id IS NOT NULL").get().n;
  assert.equal(stamped, 0);
  expectConserved(escrow);
});

test("the full signed lifecycle conserves the ledger", () => {
  const { escrow, db } = makeEscrow({ signed: true });
  const bounty = runToAccepted(escrow, { amount: 5, verifier: INSTINCT });
  // One bounty through payout, one through timeout refund, one through dispute cancel.
  tick(3 * 24 * 3_600_000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK });
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.deepEqual(epoch.summary.swept, [bounty.bountyId]);
  const b2 = post(escrow, { amount: 5 });
  escrow.fundBounty(ROOM, b2.bountyId, { funder: JILL });
  tick(3_600_000 + 1);
  escrow.finalizeBounty(ROOM, b2.bountyId, {});
  const b3 = runToSubmitted(escrow, { amount: 4, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, b3.bountyId, { challenger: CODEX, bond: 1, grounds: "bad" });
  escrow.decideDispute(ROOM, b3.bountyId, { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  expectConserved(escrow);
  // Every stamped receipt_id is well-formed and unique.
  const ids = db.prepare("SELECT DISTINCT receipt_id AS id FROM bounty_journal WHERE receipt_id IS NOT NULL").all()
    .map(r => r.id);
  assert.ok(ids.length >= 8, `expected several stamped receipts, got ${ids.length}`);
  for (const id of ids) assert.match(id, /^room-bounty-receipt:[a-z]{2}:[0-9a-f]{32}$/);
  assert.equal(new Set(ids).size, ids.length, "receiptIds are unique");
});
