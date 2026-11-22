// B1 charter §3 item 3: the 4 named behavioural cases. Additive alongside
// the hash chain; the verifier needs leaf + proof + root only, no room log.
import test from "node:test";
import assert from "node:assert/strict";
import { receiptLeaf, buildMerkleTree, getProof, verifyProof, epochOfIndex, EPOCH_SIZE } from "../server/merkle-receipts.mjs";

function corpus(n) {
  const r = [];
  for (let i = 0; i < n; i++) r.push({ id: `rcpt_${i}`, room: "room_1", amount: `${(i % 997) + 1}.00`, payer: `user_${i % 500}`, payee: `user_${(i * 7) % 500}`, ts: 1700000000 + i });
  return r;
}

test("B1 case 1: happy-path inclusion at the log midpoint verifies with leaf+proof+root only", () => {
  const receipts = corpus(999);
  const leaves = receipts.map(receiptLeaf);
  const { root } = buildMerkleTree(leaves);
  const mid = 499;
  const proof = getProof(leaves, mid);
  assert.equal(verifyProof(leaves[mid], proof, root), true);
  assert.ok(proof.path.length <= 14, "proof bounded by log2 of leaf count");
});

test("B1 case 2: tampered amount fails verification", () => {
  const receipts = corpus(101);
  const leaves = receipts.map(receiptLeaf);
  const { root } = buildMerkleTree(leaves);
  const proof = getProof(leaves, 50);
  const tampered = receiptLeaf({ ...receipts[50], amount: "99999.00" });
  assert.equal(verifyProof(tampered, proof, root), false);
});

test("B1 case 3: wrong root fails verification", () => {
  const receipts = corpus(101);
  const leaves = receipts.map(receiptLeaf);
  const { root } = buildMerkleTree(leaves);
  const other = buildMerkleTree(corpus(50).map(receiptLeaf)).root;
  assert.notEqual(other, root);
  assert.equal(verifyProof(leaves[10], getProof(leaves, 10), other), false);
});

test("B1 case 4: proof for the final leaf in an odd-count tree verifies", () => {
  const receipts = corpus(999); // odd count
  const leaves = receipts.map(receiptLeaf);
  const { root } = buildMerkleTree(leaves);
  const last = leaves.length - 1;
  assert.equal(verifyProof(leaves[last], getProof(leaves, last), root), true);
});

test("B1 epoch pin: epoch boundary is the named constant and indexes map deterministically", () => {
  assert.equal(EPOCH_SIZE, 1000);
  assert.equal(epochOfIndex(0), 0);
  assert.equal(epochOfIndex(999), 0);
  assert.equal(epochOfIndex(1000), 1);
  // A stale-epoch proof is rejected: proof carries its epoch, verifier checks it.
  const leaves = corpus(10).map(receiptLeaf);
  const { root } = buildMerkleTree(leaves);
  const proof = getProof(leaves, 3);
  assert.equal(proof.epoch, 0);
  assert.equal(verifyProof(leaves[3], { ...proof, epoch: 7 }, root), false);
});

test("B1 byte-identical leaf re-derivation: same receipt fields re-derive the same leaf", () => {
  const r = { id: "rcpt_1", room: "room_1", amount: "42.00", payer: "a", payee: "b", ts: 1700000001 };
  assert.equal(receiptLeaf(r), receiptLeaf({ ...r }));
  assert.notEqual(receiptLeaf(r), receiptLeaf({ ...r, amount: "42.01" }));
});
