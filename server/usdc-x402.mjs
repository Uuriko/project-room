// Bridge: USDC bounty rail payouts -> x402 payment instructions.
//
// When a USDC bounty is accepted and finalized, the rail (server/usdc-payouts.mjs)
// emits a payout instruction via onPayout: { bountyId, currency: "USDC", chain,
// asset, to, payeeNetRaw, protocolFeeRaw, ... }. This module turns that rail
// payout into x402 `paymentRequirements` legs — the exact message shape the
// payer's wallet needs to build the X-Payment header — using the tested logic
// vendored in server/x402.mjs.
//
// Composition (the room's settler wires this; nothing here touches the rail):
//
//   import { createUsdcRail } from "./usdc-payouts.mjs";
//   import { x402OnPayout } from "./usdc-x402.mjs";
//   const rail = createUsdcRail({
//     onPayout: x402OnPayout({ feeAddress: ROOM_FEE_WALLET, facilitator: "coinbase" }),
//   });
//   // rail.release(bountyId) -> onPayout receives the x402 instruction below.
//
// HARD BOUNDARY (John's standing money rule): the output is ALWAYS an
// instruction marked PENDING_OWNER_TAP. Nothing here signs a transaction,
// broadcasts anything, or moves funds. The owner executes the transfer
// out-of-band with their own wallet; this module only describes exactly what
// the transfer must be, so the tap is informed rather than blind.
//
// Refusals (fail closed):
// - placeholder / non-address `to` (e.g. the dispute-refund "poster"
//   placeholder) — a payment instruction to a placeholder would be bogus.
// - unknown chain, malformed amounts, zero-total payouts.
// - a fee leg is generated ONLY when a feeAddress is configured AND the fee
//   is non-zero. An unconfigured fee is recorded in the envelope, never
//   invented as a destination.

import { paymentRequirements, CHAINS as X402_CHAINS } from "./x402.mjs";

// Room rail chain names -> x402 network keys. The room's "solana" is mainnet
// Solana and MUST map to the x402 "solana" entry, never to "solana-devnet".
const RAIL_TO_X402_CHAIN = Object.freeze({ base: "base", solana: "solana" });

class X402BridgeError extends Error {
  constructor(code, message) { super(message); this.name = "X402BridgeError"; this.code = code; }
}
const fail = (code, message) => { throw new X402BridgeError(code, message); };
const check = (cond, code, message) => { if (!cond) fail(code, message); };
const rawUnits = (v, what) => check(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v), "invalid_input", `${what} must be integer raw-unit string`);

function addressKind(x402Chain) {
  return X402_CHAINS[x402Chain].kind === "evm" ? "evm" : "base58";
}
function validAddress(address, kind) {
  if (kind === "evm") return /^0x[0-9a-fA-F]{40}$/.test(address);
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// Build the x402 payout instruction for a finalized rail payout.
// payout: the object emitted by usdc-payouts release()/resolveDispute().
// feeAddress: the room's protocol-fee wallet (optional). resource: x402
// resource URI for the bounty (defaults to a room-scoped URI).
export function x402PayoutInstruction({ payout, feeAddress = null, resource = null, facilitator = null, maxTimeoutSecs = 300 } = {}) {
  check(payout && typeof payout === "object", "invalid_input", "payout required");
  check(payout.currency === "USDC", "invalid_input", `payout currency must be USDC, got "${payout.currency}"`);
  const x402Chain = RAIL_TO_X402_CHAIN[payout.chain];
  check(x402Chain, "invalid_input", `unsupported payout chain "${payout.chain}"`);
  const kind = addressKind(x402Chain);
  // Fail closed on placeholder addresses: the dispute-refund payout's
  // to: "poster" (address resolved later) must NEVER become an x402 leg.
  check(validAddress(payout.to, kind), "invalid_input",
    `payout.to is not a valid ${kind} address for chain "${payout.chain}"`);
  rawUnits(payout.payeeNetRaw, "payeeNetRaw");
  rawUnits(payout.protocolFeeRaw, "protocolFeeRaw");
  const net = BigInt(payout.payeeNetRaw);
  const fee = BigInt(payout.protocolFeeRaw);
  check(net + fee > 0n, "invalid_input", "payout total must be positive");
  check(payout.asset === X402_CHAINS[x402Chain].usdc, "invalid_input",
    `payout asset ${payout.asset} != x402 USDC ${X402_CHAINS[x402Chain].usdc} on ${x402Chain}`);
  if (feeAddress !== null) {
    check(validAddress(feeAddress, kind), "invalid_input",
      `feeAddress is not a valid ${kind} address for chain "${payout.chain}"`);
  }

  const resourceUri = resource ?? `project-room:bounty:${payout.bountyId}`;
  const legs = [{
    kind: "payee",
    payTo: payout.to,
    requirements: paymentRequirements({
      chain: x402Chain, amountRaw: payout.payeeNetRaw, payTo: payout.to,
      resource: resourceUri, facilitator, maxTimeoutSecs,
    }),
  }];
  if (feeAddress !== null && fee > 0n) {
    legs.push({
      kind: "protocol-fee",
      payTo: feeAddress,
      requirements: paymentRequirements({
        chain: x402Chain, amountRaw: payout.protocolFeeRaw, payTo: feeAddress,
        resource: resourceUri, facilitator, maxTimeoutSecs,
      }),
    });
  }

  return Object.freeze({
    kind: "x402-payout-instruction/v1",
    bountyId: payout.bountyId,
    currency: "USDC",
    chain: payout.chain, // room chain name; each leg's requirements.network is the x402 key
    asset: payout.asset,
    legs: Object.freeze(legs.map((l) => Object.freeze(l))),
    payeeNetRaw: payout.payeeNetRaw,
    protocolFeeRaw: payout.protocolFeeRaw,
    protocolFeeBps: payout.protocolFeeBps ?? null,
    feeAddress: feeAddress, // null when unconfigured — the fee is disclosed, not invented
    receiptId: payout.receiptId ?? null,
    terms: payout.terms ?? null,
    // The load-bearing marker: instruction only. Execution is the owner's tap.
    execution: "PENDING_OWNER_TAP",
    executedAt: null,
    generatedAt: new Date().toISOString(),
  });
}

// onPayout-compatible callback factory: drop straight into createUsdcRail.
export function x402OnPayout({ feeAddress = null, resource = null, facilitator = null, maxTimeoutSecs = 300 } = {}) {
  return (payout) => x402PayoutInstruction({ payout, feeAddress, resource, facilitator, maxTimeoutSecs });
}

export { X402BridgeError, RAIL_TO_X402_CHAIN };
