// Tests for server/vetting-receipts.mjs — signed vetting receipts for the
// Demigod x Project Room jobs integration (record-only: no money moves).
//
// Contract under test (owner boundary: issue/verify/consumer-schema):
//   - issue -> verify round-trips a well-formed receipt (attestation)
//   - any tamper of the signed body breaks the signature (anti-tamper)
//   - JSON numbers inside the signed body are rejected (canonicalization hazard)
//   - receipts outside the freshness window are rejected (staleness)
//   - a receiptId that already verified is rejected (replay protection)
//   - verification is fail-closed: no trusted key, no verification
//   - the consumer schema validates a good receipt and rejects malformed ones
//     (the cross-org handoff contract with Demigod)
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_TYPE_VETTING,
  issueVettingReceipt,
  verifyVettingReceipt,
  vettingReceiptConsumerSchema,
  generateReceiptKeyPair,
  ReceiptError,
} from "../server/vetting-receipts.mjs";

const NOW = Date.parse("2026-10-06T00:30:00.000Z");
const ISSUED_AT = "2026-10-06T00:30:00.000Z";

const goodParams = (overrides = {}) => ({
  trialTaskId: "trial-7f3a",
  demigodReqId: "req-0042",
  candidateId: "agent:rivet",
  scope: { hoursMax: "8", deliverableShape: "a working prototype PR" },
  rubricScores: [
    { criterion: "correctness", scoreBps: "8500" },
    { criterion: "communication", scoreBps: "9000" },
  ],
  verdict: "pass",
  evaluator: { kind: "human", id: "reviewer:ada" },
  issuedAt: ISSUED_AT,
  receiptId: `vetting-receipt:${"ab".repeat(16)}`,
  now: NOW,
  ...overrides,
});

test("issue -> verify round-trips with the simple (receipt, pubkey) form", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  assert.equal(receipt.receiptType, RECEIPT_TYPE_VETTING);
  const check = verifyVettingReceipt(receipt, keypair.pubkeyHex);
  assert.equal(check.ok, true);
  assert.equal(check.receiptId, receipt.receiptId);
  assert.equal(check.verdict, "pass");
  assert.equal(check.candidateId, "agent:rivet");
});

test("tampering with a rubric score breaks the signature", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const tampered = {
    ...receipt,
    rubricScores: [
      { criterion: "correctness", scoreBps: "10000" },
      { criterion: "communication", scoreBps: "9000" },
    ],
  };
  const check = verifyVettingReceipt(tampered, keypair.pubkeyHex);
  assert.equal(check.ok, false);
  assert.match(check.reason, /^bad_signature/);
});

test("a JSON number inside the signed body is rejected before signature checks", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const asJson = JSON.parse(JSON.stringify(receipt));
  asJson.rubricScores[0].scoreBps = 8500; // number, not string
  const check = verifyVettingReceipt(JSON.stringify(asJson), keypair.pubkeyHex);
  assert.equal(check.ok, false);
  assert.match(check.reason, /number_ban/);
});

test("an expired receipt is rejected", () => {
  const keypair = generateReceiptKeyPair();
  const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
  const receipt = issueVettingReceipt(
    goodParams({ issuedAt: eightDaysAgo, now: NOW - 8 * 24 * 60 * 60 * 1000 }),
    keypair,
  );
  const check = verifyVettingReceipt(receipt, { expectedPubkey: keypair.pubkeyHex, now: NOW });
  assert.equal(check.ok, false);
  assert.match(check.reason, /^stale_receipt/);
});

test("a future receipt beyond the clock-skew window is rejected", () => {
  const keypair = generateReceiptKeyPair();
  const ahead = new Date(NOW + 10 * 60 * 1000).toISOString();
  const receipt = issueVettingReceipt(goodParams({ issuedAt: ahead, now: NOW + 10 * 60 * 1000 }), keypair);
  const check = verifyVettingReceipt(receipt, { expectedPubkey: keypair.pubkeyHex, now: NOW });
  assert.equal(check.ok, false);
  assert.match(check.reason, /^future_receipt/);
});

test("replay: the second verification of the same receiptId is rejected", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const seen = new Set();
  const first = verifyVettingReceipt(receipt, { expectedPubkey: keypair.pubkeyHex, seen, now: NOW });
  assert.equal(first.ok, true);
  const second = verifyVettingReceipt(receipt, { expectedPubkey: keypair.pubkeyHex, seen, now: NOW });
  assert.equal(second.ok, false);
  assert.match(second.reason, /^duplicate_receipt/);
});

test("fail-closed: verification without a trusted key is refused", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const check = verifyVettingReceipt(receipt, {});
  assert.equal(check.ok, false);
  assert.match(check.reason, /^untrusted_issuer/);
});

test("fail-closed: a signature from the wrong key is rejected", () => {
  const keypair = generateReceiptKeyPair();
  const other = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const check = verifyVettingReceipt(receipt, other.pubkeyHex);
  assert.equal(check.ok, false);
  assert.match(check.reason, /^bad_signature/);
});

test("fail-closed: identity binding — an empty candidateId cannot be issued", () => {
  const keypair = generateReceiptKeyPair();
  assert.throws(
    () => issueVettingReceipt(goodParams({ candidateId: "" }), keypair),
    err => err instanceof ReceiptError && /candidateId/.test(err.message),
  );
});

test("identity binding: expectedCandidateId mismatch is rejected", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const check = verifyVettingReceipt(receipt, {
    expectedPubkey: keypair.pubkeyHex,
    expectedCandidateId: "agent:someone-else",
    now: NOW,
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /^context_mismatch/);
});

test("duplicate JSON keys are rejected by the strict parser", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const text = JSON.stringify(receipt);
  const duped = text.replace('"receiptType"', '"receiptType":"vetting/1","receiptType"');
  const check = verifyVettingReceipt(duped, keypair.pubkeyHex);
  assert.equal(check.ok, false);
  assert.match(check.reason, /invalid_json/);
});

// --- consumer schema: the Demigod handoff contract ---------------------------
//
// Demigod validates incoming receipts against the descriptor returned by
// vettingReceiptConsumerSchema(). This test drives the descriptor as a real
// validator: a good receipt must pass, and each malformed receipt must fail.

function validateAgainst(schema, value, path = "receipt") {
  const problems = [];
  if (schema.const !== undefined && value !== schema.const)
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value))
    problems.push(`${path}: expected one of ${schema.enum.join("|")}`);
  if (schema.type === "string") {
    if (typeof value !== "string") problems.push(`${path}: expected string`);
    else {
      if (schema.minLength !== undefined && value.length < schema.minLength)
        problems.push(`${path}: too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        problems.push(`${path}: too long`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
        problems.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      problems.push(`${path}: expected object`);
    else {
      for (const k of schema.required ?? [])
        if (!(k in value)) problems.push(`${path}: missing required ${k}`);
      if (schema.additionalProperties === false)
        for (const k of Object.keys(value))
          if (!(k in (schema.properties ?? {}))) problems.push(`${path}: unexpected property ${k}`);
      for (const [k, sub] of Object.entries(schema.properties ?? {}))
        if (k in value) problems.push(...validateAgainst(sub, value[k], `${path}.${k}`));
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) problems.push(`${path}: expected array`);
    else if (schema.items)
      value.forEach((v, n) => problems.push(...validateAgainst(schema.items, v, `${path}[${n}]`)));
  }
  return problems;
}

test("consumer schema validates a good receipt", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const schema = vettingReceiptConsumerSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(receipt).filter(k => k !== "signature").concat("signature").sort());
  const problems = validateAgainst(schema, receipt);
  assert.deepEqual(problems, []);
});

test("consumer schema documents the handoff", () => {
  const schema = vettingReceiptConsumerSchema();
  assert.match(schema.description, /GET \/trial-tasks\/:id\/receipt/);
  assert.match(schema.description, /published key/);
  assert.match(schema.description, /identity binding/);
});

test("consumer schema rejects malformed receipts", () => {
  const keypair = generateReceiptKeyPair();
  const receipt = issueVettingReceipt(goodParams(), keypair);
  const schema = vettingReceiptConsumerSchema();
  const malformed = [
    ["missing verdict", ({ verdict, ...rest }) => rest],
    ["wrong receiptType", r => ({ ...r, receiptType: "vetting/2" })],
    ["numeric score", r => ({ ...r, rubricScores: [{ criterion: "c", scoreBps: 8500 }] })],
    ["bad verdict", r => ({ ...r, verdict: "maybe" })],
    ["extra property", r => ({ ...r, bonusField: "x" })],
    ["empty candidateId", r => ({ ...r, candidateId: "" })],
  ];
  for (const [label, mutate] of malformed) {
    const problems = validateAgainst(schema, mutate(receipt));
    assert.ok(problems.length > 0, `schema accepted a malformed receipt: ${label}`);
  }
});
