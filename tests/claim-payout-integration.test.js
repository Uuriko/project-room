// End-to-end: claim → signed receipt → x402 payout instruction → owner tap.
// Exercises the full "escrow hangs off the same receipt" loop using only
// pure modules (no HTTP, no store). Proves the composition works: the receipt
// produced by public-claims.mjs is accepted by receipt-payout.mjs, and the
// resulting instruction carries PENDING_OWNER_TAP through the owner queue.
//
// Authoring gate:
// 1. Protects: the cross-module contract (receipt shape → instruction input).
//    If either module changes its shape incompatibly, this fails.
// 2. Regression: a refactor in public-claims that renames receiptId, or in
//    receipt-payout that stops accepting the receipt's issuer shape.
// 3. Existing coverage: unit tests cover each module in isolation; none covers
//    the handoff between them.
// 4. No production seam: uses only public exports.
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicClaimRegistry } from "../server/public-claims.mjs";
import { receiptToInstruction, createPayoutQueue } from "../server/receipt-payout.mjs";

const WORKER = Object.freeze({ id: "ai_worker1", displayName: "Worker One" });
const OWNER = "owner_john";

test("claim → receipt → instruction → owner approve (happy path)", () => {
  const registry = createPublicClaimRegistry();
  const queue = createPayoutQueue();

  // 1. Worker claims the task.
  const claim = registry.create({
    taskId: "BOUNTY-001",
    claimant: WORKER,
    scope: { kind: "bounty", description: "Fix the login bug" },
  });
  assert.equal(claim.state, "active");

  // 2. Worker completes; registry issues a signed receipt.
  const { receipt } = registry.complete(claim.id, WORKER.id, {
    summary: "Fixed null pointer in auth flow.",
  });
  assert.ok(receipt.receiptId);
  assert.ok(receipt.signatures && receipt.signatures.length > 0, "receipt must be signed");
  assert.equal(receipt.signatures[0].algorithm, "Ed25519");
  assert.equal(receipt.claimId, claim.id);

  // 3. Receipt + bounty details → x402 instruction.
  const instruction = receiptToInstruction({
    receipt,
    bounty: {
      bountyId: "bounty-001",
      amountRaw: "5000000", // 5 USDC
      chain: "base",
      payeeAddress: "0x1234567890abcdef1234567890abcdef12345678",
      protocolFeeBps: 200,
    },
  });
  assert.equal(instruction.execution, "PENDING_OWNER_TAP");
  assert.equal(instruction.receiptId, receipt.receiptId);
  // 5 USDC = 5000000 raw; 2% = 100000 fee; 4900000 net
  assert.equal(instruction.payeeNetRaw, "4900000");
  assert.equal(instruction.protocolFeeRaw, "100000");

  // 4. Enqueue for owner review.
  const entry = queue.enqueue({
    instruction,
    receiptId: receipt.receiptId,
    bountyId: "bounty-001",
  });
  assert.equal(entry.state, "pending");
  assert.equal(queue.pending().length, 1);

  // 5. Owner taps approve. Execution remains out-of-band.
  const approved = queue.approve(entry.id, OWNER, "Work verified.");
  assert.equal(approved.state, "approved");
  assert.equal(approved.decidedBy, OWNER);
  assert.equal(approved.instruction.execution, "PENDING_OWNER_TAP",
    "approval must not change the instruction to executed");
  assert.equal(queue.pending().length, 0);
});

test("second worker cannot claim the same task while lease is active", () => {
  const registry = createPublicClaimRegistry();
  registry.create({
    taskId: "BOUNTY-002",
    claimant: WORKER,
    scope: { kind: "bounty" },
  });
  assert.throws(
    () => registry.create({
      taskId: "BOUNTY-002",
      claimant: { id: "ai_worker2", displayName: "Worker Two" },
      scope: { kind: "bounty" },
    }),
    (e) => e.code === "claim_conflict"
  );
});

test("owner can reject a suspicious instruction", () => {
  const registry = createPublicClaimRegistry();
  const queue = createPayoutQueue();

  const claim = registry.create({
    taskId: "BOUNTY-003",
    claimant: WORKER,
    scope: { kind: "bounty" },
  });
  const { receipt } = registry.complete(claim.id, WORKER.id, { summary: "done" });

  const instruction = receiptToInstruction({
    receipt,
    bounty: {
      bountyId: "bounty-003",
      amountRaw: "1000000",
      chain: "solana",
      payeeAddress: "4zMMC9srt5Ri5X14GAgXhaHii3LuvCKZYJJ6gM4R9cT",
    },
  });
  const entry = queue.enqueue({
    instruction,
    receiptId: receipt.receiptId,
    bountyId: "bounty-003",
  });
  const rejected = queue.reject(entry.id, OWNER, "Amount does not match bounty terms.");
  assert.equal(rejected.state, "rejected");
  assert.equal(queue.pending().length, 0);
});
