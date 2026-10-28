// merkle-receipts.mjs — Merkle receipt proofs, ADDITIVE alongside the
// existing hash chain (DISCOVERY-50 lane B1, charter
// B1-merkle-receipt-proofs). The chain is not replaced, reordered, or
// migrated; receipt issuance, amounts, settle and fee semantics are
// untouched; no signer provisioning, no signed roots, no copy here
// claims signed verification. NOT dependent on signer provisioning.
//
// A tree is built per room per epoch over the existing receipt leaves.
// EPOCH_SIZE is the named epoch-boundary constant (leaves per epoch),
// pinned by tests/merkle-receipt-proofs.test.mjs. A proof names its
// epoch and root; the standalone verifier (verifyProof) checks a proof
// with leaf + sibling path + root ONLY — no access to the room log —
// and rejects a proof whose epoch does not match the caller's epoch.
//
// Leaf derivation is byte-identical for identical receipt fields
// (canonical field order, sha256) — a room whose leaves cannot be
// re-derived byte-identically is reported, not approximated (that
// check belongs to the caller building the tree; receiptLeaf is the
// single derivation).

import { createHash } from "node:crypto";

export const EPOCH_SIZE = 1000;

const hashHex = (...parts) => createHash("sha256").update(parts.join("|")).digest("hex");

// Canonical leaf for a receipt: fixed field order, string amounts
// verbatim (amounts are decimal strings in the receipt layer).
export function receiptLeaf(receipt) {
  return hashHex(receipt.id, receipt.room, receipt.amount, receipt.payer, receipt.payee, String(receipt.ts));
}

export function epochOfIndex(index) {
  return Math.floor(index / EPOCH_SIZE);
}

export function buildMerkleTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new TypeError("buildMerkleTree: at least one leaf is required");
  const levels = [leaves.slice()];
  let level = levels[0];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a; // odd count: last node pairs with itself
      next.push(hashHex(a, b));
    }
    levels.push(next);
    level = next;
  }
  return { root: level[0], levels, leafCount: leaves.length };
}

// Proof for one leaf: sibling path + root + epoch. Bounded at log2 of
// the leaf count hashes (<= 14 for 10,000 leaves).
export function getProof(leaves, index, epoch = epochOfIndex(index)) {
  const { root, levels } = buildMerkleTree(leaves);
  const path = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const sib = idx ^ 1;
    path.push({ hash: level[sib] ?? level[idx], left: sib < idx });
    idx >>= 1;
  }
  return { index, epoch, root, path };
}

// Standalone verifier: leaf + proof + root, no room log access.
// Returns false (a distinct, named failure outcome at call sites) for
// a tampered leaf, a wrong root, or a stale/mismatched epoch.
export function verifyProof(leaf, proof, root, expectedEpoch = null) {
  if (!proof || proof.root !== root) return false;
  // A proof's epoch must be the epoch its leaf index actually belongs
  // to, and must match the caller's expected epoch when one is pinned:
  // a stale-epoch proof is rejected, never silently re-based.
  if (proof.epoch !== epochOfIndex(proof.index)) return false;
  if (expectedEpoch !== null && proof.epoch !== expectedEpoch) return false;
  let current = leaf;
  for (const step of proof.path) {
    current = step.left ? hashHex(step.hash, current) : hashHex(current, step.hash);
  }
  return current === root;
}
