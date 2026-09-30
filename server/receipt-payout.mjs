// Receipt → x402 payout instruction consumer + owner release queue.
//
// John's directive (2026-09-30): "escrow hangs off the same receipt, which is
// the bounty work already in flight."
//
// The public claim verb (server/public-claims.mjs) produces signed receipts.
// This module consumes a receipt and turns it into an x402 payout instruction
// — the exact message the owner's wallet needs to execute the USDC transfer.
//
// What this module IS:
// - A pure transformer: receipt + bounty details → payout object → x402
//   instruction (via server/usdc-x402.mjs x402PayoutInstruction).
// - An owner release queue: instructions wait here for the owner's tap.
//   The owner reviews, approves, or rejects. Approval records the decision;
//   it does NOT execute anything.
//
// What this module IS NOT (hard boundaries):
// - It NEVER instantiates createUsdcRail() (settlement internal).
// - It NEVER registers x402OnPayout with the rail (settlement internal).
// - It NEVER modifies bounty-escrow-routes.mjs (settlement internal).
// - It NEVER signs a transaction, broadcasts anything, or moves funds.
//   Execution happens out-of-band in the owner's wallet, using the
//   instruction this module produces. The instruction is always marked
//   PENDING_OWNER_TAP.
//
// Relationship to Instinct's RFC #1233 D/E:
// - D (poster-direct payout verification, settlement journal, replay fence)
//   verifies payouts happened. This module generates the instruction that
//   the payout executes. Complementary, not overlapping.
// - E (MCP idempotency) is unrelated.
// - If economy owns Phase 1 (live rail integration), this consumer still
//   stands alone: it works from receipts, not from the rail.

import { x402PayoutInstruction, X402BridgeError } from "./usdc-x402.mjs";

class ReceiptPayoutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReceiptPayoutError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new ReceiptPayoutError(code, message); };
const check = (cond, code, message) => { if (!cond) fail(code, message); };

// Build the payout object that x402PayoutInstruction() expects,
// from a claim receipt + bounty details.
//
// receipt: { receiptId, claimId, taskId, issuer: { id, displayName }, ... }
//   (the frozen receipt from server/public-claims.mjs complete())
// bounty: { bountyId, amountRaw, chain, payeeAddress, protocolFeeBps? }
//   - amountRaw: integer raw-unit string (6-decimal USDC), e.g. "1000000" = 1 USDC
//   - chain: "base" or "solana" (room chain names)
//   - payeeAddress: the worker's wallet address (validated by x402PayoutInstruction)
//   - protocolFeeBps: optional, defaults to the rail default (200 = 2%)
//
// Returns the frozen x402 instruction envelope (PENDING_OWNER_TAP).
export function receiptToInstruction({ receipt, bounty, feeAddress = null } = {}) {
  check(receipt && typeof receipt === "object", "invalid_input", "receipt required");
  check(receipt.receiptId, "invalid_input", "receipt.receiptId required");
  check(receipt.claimId, "invalid_input", "receipt.claimId required");
  check(bounty && typeof bounty === "object", "invalid_input", "bounty required");
  check(bounty.bountyId, "invalid_input", "bounty.bountyId required");
  check(typeof bounty.amountRaw === "string" && /^(0|[1-9][0-9]*)$/.test(bounty.amountRaw),
    "invalid_input", "bounty.amountRaw must be integer raw-unit string");
  check(["base", "solana"].includes(bounty.chain),
    "invalid_input", `bounty.chain must be "base" or "solana", got "${bounty.chain}"`);
  check(typeof bounty.payeeAddress === "string" && bounty.payeeAddress.length > 0,
    "invalid_input", "bounty.payeeAddress required");

  // Split amount into payee net + protocol fee.
  const feeBps = bounty.protocolFeeBps ?? 200;
  check(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 1000,
    "invalid_input", "protocolFeeBps must be integer 0-1000");
  const total = BigInt(bounty.amountRaw);
  const fee = (total * BigInt(feeBps)) / 10000n;
  const net = total - fee;

  // Asset address per chain (must match the x402 module's expectations).
  const asset = bounty.chain === "base"
    ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const payout = {
    bountyId: bounty.bountyId,
    currency: "USDC",
    chain: bounty.chain,
    asset,
    to: bounty.payeeAddress,
    payeeNetRaw: net.toString(),
    protocolFeeRaw: fee.toString(),
    protocolFeeBps: feeBps,
    receiptId: receipt.receiptId,
    terms: `Claim ${receipt.claimId} completed by ${receipt.issuer?.displayName ?? receipt.issuer?.id ?? "worker"}`,
  };

  try {
    return x402PayoutInstruction({ payout, feeAddress });
  } catch (e) {
    if (e instanceof X402BridgeError) fail(e.code, e.message);
    throw e;
  }
}

// Owner release queue — instructions awaiting the owner's tap.
// In-memory (per-process). A future slice persists to store.mjs.
//
// States: pending → approved | rejected
// Approved does NOT mean executed — it means the owner reviewed the
// instruction and authorized execution. Execution happens out-of-band.
export function createPayoutQueue() {
  const instructions = new Map(); // instructionId -> { instruction, receiptId, bountyId, state, history }

  const publicInstruction = (entry) => {
    const { instruction, receiptId, bountyId, state, createdAt, decidedAt, decidedBy, decisionNote } = entry;
    return Object.freeze({
      id: entry.id,
      instruction,
      receiptId,
      bountyId,
      state,
      createdAt,
      decidedAt: decidedAt ?? null,
      decidedBy: decidedBy ?? null,
      decisionNote: decisionNote ?? null,
    });
  };

  return {
    // Enqueue an instruction for owner review. Returns the queue entry.
    enqueue({ instruction, receiptId, bountyId }) {
      check(instruction && instruction.kind === "x402-payout-instruction/v1",
        "invalid_input", "instruction must be an x402-payout-instruction/v1 envelope");
      check(instruction.execution === "PENDING_OWNER_TAP",
        "invalid_input", "instruction must be PENDING_OWNER_TAP");
      check(receiptId, "invalid_input", "receiptId required");
      check(bountyId, "invalid_input", "bountyId required");

      const id = `po_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = {
        id,
        instruction: Object.freeze(instruction),
        receiptId,
        bountyId,
        state: "pending",
        createdAt: Date.now(),
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        history: [{ at: Date.now(), action: "enqueued", note: "Awaiting owner tap." }],
      };
      instructions.set(id, entry);
      return publicInstruction(entry);
    },

    // List pending instructions (owner view).
    pending() {
      const result = [];
      for (const entry of instructions.values()) {
        if (entry.state === "pending") result.push(publicInstruction(entry));
      }
      result.sort((a, b) => a.createdAt - b.createdAt); // oldest first (FIFO)
      return Object.freeze(result);
    },

    // Get any instruction by ID.
    get(id) {
      const entry = instructions.get(id);
      return entry ? publicInstruction(entry) : null;
    },

    // Owner approves — records the tap. Does NOT execute.
    approve(id, ownerId, note) {
      const entry = instructions.get(id);
      if (!entry) fail("not_found", "Instruction not found.");
      if (entry.state !== "pending") fail("not_pending", `Instruction is ${entry.state}, not pending.`);
      check(ownerId, "invalid_input", "ownerId required");
      entry.state = "approved";
      entry.decidedAt = Date.now();
      entry.decidedBy = ownerId;
      entry.decisionNote = note ?? "Approved by owner. Execute out-of-band with wallet.";
      entry.history.push({ at: entry.decidedAt, action: "approved", note: entry.decisionNote });
      return publicInstruction(entry);
    },

    // Owner rejects — records the decision with a reason.
    reject(id, ownerId, reason) {
      const entry = instructions.get(id);
      if (!entry) fail("not_found", "Instruction not found.");
      if (entry.state !== "pending") fail("not_pending", `Instruction is ${entry.state}, not pending.`);
      check(ownerId, "invalid_input", "ownerId required");
      check(reason, "invalid_input", "reason required for rejection");
      entry.state = "rejected";
      entry.decidedAt = Date.now();
      entry.decidedBy = ownerId;
      entry.decisionNote = reason;
      entry.history.push({ at: entry.decidedAt, action: "rejected", note: reason });
      return publicInstruction(entry);
    },

    // For testing.
    _clear() { instructions.clear(); },
  };
}

export { ReceiptPayoutError };
