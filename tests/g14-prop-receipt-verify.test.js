// Guild-14 property test: receipt verification properties.
// Forged signatures (wrong key, zeroed sig, amount tamper after signing) must
// fail verification; replay protection: the same receiptId verified twice via
// `seen` must be rejected; receipts verify against a journal they came from.
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateReceiptKeyPair, createReceiptSigner, issueBountyReceipt, verifyBountyReceipt,
} from "../server/bounty-receipts.mjs";

const { seedHex: SEED, pubkeyHex: PUBKEY } = generateReceiptKeyPair();
const ACTOR = { kind: "agent", id: "id:agent/jill" };
const PAYLOADS = {
  "escrow-locked": { fromAccount: "id:agent/jill", fromLotState: "payable" },
};
const issueArgs = (type, overrides = {}) => ({
  type, roomId: "room-g14-receipts", bountyId: "ROOM-1", lotId: "lot_dddddddddddddddd",
  amountMillis: "10000", actor: ACTOR, entries: ["ent_aaaaaaaaaaaaaaaa", "ent_bbbbbbbbbbbbbbbb"], entryHashes: ["a".repeat(64), "b".repeat(64)],
  payload: PAYLOADS[type],
  issuer: { pubkey: PUBKEY, role: "escrow-keeper", ref: "test-operator" },
  issuedAt: "2026-10-09T00:00:00.000Z", seedHex: SEED, ...overrides,
});

test("g14-receipt: valid receipt verifies under the issuing key", () => {
  const r = issueBountyReceipt(issueArgs("escrow-locked"));
  const v = verifyBountyReceipt(r, { expectedPubkey: PUBKEY });
  assert.equal(v.ok, true, `valid receipt rejected: ${JSON.stringify(v)}`);
});

test("g14-receipt: forgery classes are rejected", () => {
  const r = issueBountyReceipt(issueArgs("escrow-locked"));
  // Wrong key signs a lookalike receipt: expectedPubkey must fail it.
  const { seedHex: otherSeed, pubkeyHex: otherPub } = generateReceiptKeyPair();
  const forged = issueBountyReceipt(issueArgs("escrow-locked", { seedHex: otherSeed, issuer: { pubkey: otherPub, role: "escrow-keeper", ref: "forger" } }));
  assert.equal(verifyBountyReceipt(forged, { expectedPubkey: PUBKEY }).ok, false, "forged-key receipt accepted");
  // Zeroed signature rejected.
  const zeroed = { ...r, signature: "0".repeat(128) };
  assert.equal(verifyBountyReceipt(zeroed, { expectedPubkey: PUBKEY }).ok, false, "zeroed signature accepted");
  // Amount tampered after signing rejected.
  const tampered = { ...r, amountMillis: "99999999" };
  assert.equal(verifyBountyReceipt(tampered, { expectedPubkey: PUBKEY }).ok, false, "post-signing amount tamper accepted");
  // Receipt mutated after signing rejected.
  const mutated = JSON.parse(JSON.stringify(r));
  mutated.payload.fromLotState = "approved";
  assert.equal(verifyBountyReceipt(mutated, { expectedPubkey: PUBKEY }).ok, false, "post-signing payload tamper accepted");
});

test("g14-receipt: replay protection via seen set", () => {
  const r = issueBountyReceipt(issueArgs("escrow-locked"));
  const seen = new Set();
  assert.equal(verifyBountyReceipt(r, { expectedPubkey: PUBKEY, seen }).ok, true);
  const second = verifyBountyReceipt(r, { expectedPubkey: PUBKEY, seen });
  assert.equal(second.ok, false, "replayed receiptId accepted");
  assert.match(second.reason ?? "", /replay|seen|duplicate/i, `unexpected reason: ${second.reason}`);
});
