// USDC payout rail for room bounties — the parallel rail next to the ledger-credit
// dogfood (slice 1: escrowed bounties between John's own agents, credits only).
//
// What this module is:
// - Bounties denominable in USDC alongside the existing ledger credits.
// - Escrow-backed lifecycle reusing BountyEscrow semantics:
//   post -> fund -> claim -> verify -> release | dispute -> resolved.
// - Protocol fee: default 2% (200 bps), room-configurable, disclosed on every bounty.
// - Payouts addressed to agent wallet addresses taken from the agent card /
//   ERC-8004 identity reference.
//
// What this module is NOT, and the boundary it keeps:
// - The USDC rail is live: every operation below works with no feature flag.
//   (An earlier revision gated the rail behind config.usdcEnabled defaulting to
//   false; the gate was removed 2026-09-29 — USDC is part of the build.)
// - The module records payout INSTRUCTIONS and emits them via `onPayout`. It never
//   moves real money itself: no private keys, no chain writes, no transactions.
//   Executing a payout instruction (broadcasting the USDC transfer) happens
//   outside this module, in whatever settler the room runs.
// - Credits are untouched: this rail is parallel, never a replacement. The
//   slice-1 rule stands — credits are valueless ledger units with no cash-out.
//
// Pure and dependency-free like bounty-disputes.mjs: all state is caller-owned
// (a Map); malformed inputs and illegal transitions throw UsdcRailError.
//
// Amounts are integer raw-unit STRINGS (6-decimal USDC convention) — never floats.
const DEFAULT_FEE_BPS = 200; // 2% — room-configurable, disclosed on every bounty
const MAX_FEE_BPS = 1000; // 10% cap — a room cannot configure an abusive fee silently

// Chain + asset allowlist. USDC only: GENIUS Act consolidated compliant agent
// payments on USDC; USDT is absent from the x402 rail this module settles alongside.
const CHAINS = Object.freeze({
  base: Object.freeze({ chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", addressKind: "evm" }),
  solana: Object.freeze({ chainId: null, usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", addressKind: "base58" }),
});

class UsdcRailError extends Error {
  constructor(code, message) { super(message); this.name = "UsdcRailError"; this.code = code; }
}
const fail = (code, message) => { throw new UsdcRailError(code, message); };
const check = (cond, code, message) => { if (!cond) fail(code, message); };
const nonEmptyString = (v, what) => check(typeof v === "string" && v.length > 0, "invalid_input", `${what} must be a non-empty string`);
const rawUnits = (v, what) => check(typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v), "invalid_input", `${what} must be integer raw-unit string`);

function validAddress(address, kind) {
  if (kind === "evm") return /^0x[0-9a-fA-F]{40}$/.test(address);
  // base58, 32-44 chars — format check only, not an ownership proof
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// Disclosed terms travel with every bounty — the fee is never a surprise.
function disclosedTerms(feeBps) {
  return Object.freeze({
    currency: "USDC",
    protocolFeeBps: feeBps,
    protocolFeePct: `${feeBps / 100}%`,
    feeRule: "fee taken ONLY on payout — never on post, fund, dispute, or refund",
    settlement: "release emits a payout instruction via onPayout; the transfer itself is executed outside this module",
  });
}

export function createUsdcRail({ store, config = {}, onPayout } = {}) {
  check(store === undefined || store instanceof Map, "invalid_input", "store must be a Map if given");
  check(onPayout === undefined || typeof onPayout === "function", "invalid_input", "onPayout must be a function if given");

  const feeBps = config.protocolFeeBps ?? DEFAULT_FEE_BPS;
  check(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= MAX_FEE_BPS, "invalid_input",
    `protocolFeeBps must be an integer 0..${MAX_FEE_BPS}`);

  const bounties = store ?? new Map();
  const get = (id) => {
    nonEmptyString(id, "bountyId");
    check(bounties.has(id), "unknown_bounty", `unknown bounty "${id}"`);
    return bounties.get(id);
  };
  const set = (b) => bounties.set(b.bountyId, Object.freeze(b));
  const requireState = (b, ...allowed) => {
    if (!allowed.includes(b.state)) fail("invalid_transition", `bounty "${b.bountyId}" cannot move ${b.state} -> ${allowed.join("|")}`);
  };

  return {
    // Inspectable rail terms, so members always know the live fee and currency.
    railStatus() {
      return Object.freeze({ protocolFeeBps: feeBps, currency: "credits|USDC" });
    },

    // Post a USDC-denominated bounty. No funds move at post (BountyEscrow: no fee on deposits).
    post({ bountyId, poster, amountRaw, chain = "base", title, acceptanceCriteria = "" }) {
      nonEmptyString(bountyId, "bountyId"); nonEmptyString(poster, "poster");
      nonEmptyString(title, "title"); rawUnits(amountRaw, "amountRaw");
      check(Object.hasOwn(CHAINS, chain), "invalid_input", `unsupported chain "${chain}" (allowlist: ${Object.keys(CHAINS).join(", ")})`);
      check(!bounties.has(bountyId), "duplicate_bounty", `bounty "${bountyId}" already exists`);
      const b = {
        bountyId, poster, title, acceptanceCriteria, currency: "USDC",
        amountRaw, chain, asset: CHAINS[chain].usdc,
        state: "posted", terms: disclosedTerms(feeBps),
        fundTxRef: null, claim: null, verification: null, dispute: null, payout: null,
        history: [{ at: new Date().toISOString(), event: "posted", by: poster }],
      };
      set(b);
      return b;
    },

    // Fund: the poster locks the full amount. fundTxRef is the chain
    // transaction reference — recorded here; the transfer itself executes
    // outside this module.
    fund(bountyId, { by, fundTxRef }) {
      const b = get(bountyId);
      requireState(b, "posted");
      nonEmptyString(by, "by"); nonEmptyString(fundTxRef, "fundTxRef");
      check(by === b.poster, "not_poster", "only the poster can fund");
      set({ ...b, state: "funded", fundTxRef,
        history: [...b.history, { at: new Date().toISOString(), event: "funded", by, fundTxRef }] });
      return get(bountyId);
    },

    // Claim: one active claimant, with the wallet address from their agent card /
    // ERC-8004 identity. Format-checked here; ownership is proven at payout time.
    claim(bountyId, { claimant, payoutAddress, erc8004Identity = null }) {
      const b = get(bountyId);
      requireState(b, "funded");
      nonEmptyString(claimant, "claimant"); nonEmptyString(payoutAddress, "payoutAddress");
      const kind = CHAINS[b.chain].addressKind;
      check(validAddress(payoutAddress, kind), "invalid_input",
        `payoutAddress is not a valid ${kind} address for chain "${b.chain}"`);
      if (erc8004Identity !== null) nonEmptyString(erc8004Identity, "erc8004Identity");
      set({ ...b, state: "claimed",
        claim: Object.freeze({ claimant, payoutAddress, erc8004Identity, at: new Date().toISOString() }),
        history: [...b.history, { at: new Date().toISOString(), event: "claimed", by: claimant }] });
      return get(bountyId);
    },

    // Verify: a verifier distinct from the claimant accepts the work, attaching the
    // receipt reference (Ed25519 signed-receipt id from the settlement layer).
    // Structural check only — cryptographic verification belongs to the receipt layer.
    verify(bountyId, { verifier, receiptId, approved }) {
      const b = get(bountyId);
      requireState(b, "claimed");
      nonEmptyString(verifier, "verifier"); nonEmptyString(receiptId, "receiptId");
      check(typeof approved === "boolean", "invalid_input", "approved must be boolean");
      check(verifier !== b.claim.claimant, "verifier_conflict", "verifier must be distinct from the claimant");
      if (!approved) {
        // Rejected verification returns the bounty to funded (claimant can re-submit).
        set({ ...b, state: "funded", claim: null,
          verification: Object.freeze({ verifier, receiptId, approved, at: new Date().toISOString() }),
          history: [...b.history, { at: new Date().toISOString(), event: "verification_rejected", by: verifier }] });
        return get(bountyId);
      }
      set({ ...b, state: "verified",
        verification: Object.freeze({ verifier, receiptId, approved, at: new Date().toISOString() }),
        history: [...b.history, { at: new Date().toISOString(), event: "verified", by: verifier }] });
      return get(bountyId);
    },

    // Release: computes the payout instruction (fee ONLY on payout) and emits it via
    // onPayout. The actual USDC transfer is NOT executed here — the instruction is
    // consumed by the room's settler. This is the load-bearing boundary: this module
    // records instructions; it never holds keys or broadcasts transactions.
    release(bountyId) {
      const b = get(bountyId);
      requireState(b, "verified");
      const gross = BigInt(b.amountRaw);
      const fee = (gross * BigInt(feeBps)) / 10000n;
      const payout = Object.freeze({
        bountyId: b.bountyId, currency: "USDC", chain: b.chain, asset: b.asset,
        to: b.claim.payoutAddress,
        payeeNetRaw: (gross - fee).toString(),
        protocolFeeRaw: fee.toString(),
        protocolFeeBps: feeBps,
        receiptId: b.verification.receiptId,
        terms: b.terms,
        // Explicit: instruction only — execution happens outside this module.
        execution: "PENDING_SETTLEMENT",
      });
      // M-17: the settler callback runs BEFORE the terminal commit. A
      // throwing settler leaves the bounty in "verified" (retryable) instead
      // of recorded-and-lost; the throw propagates to the caller.
      if (onPayout) onPayout(payout);
      set({ ...b, state: "released", payout,
        history: [...b.history, { at: new Date().toISOString(), event: "released", by: "rail" }] });
      return payout;
    },

    // Dispute: freezes a funded bounty. Designed to compose with
    // createDisputes' onDisputeFinalized — the committee's ruling comes back
    // through resolveDispute (exactly one eventual callback, same as slice 1).
    dispute(bountyId, { by, reason }) {
      const b = get(bountyId);
      requireState(b, "funded");
      nonEmptyString(by, "by"); nonEmptyString(reason, "reason");
      set({ ...b, state: "disputed",
        dispute: Object.freeze({ by, reason, at: new Date().toISOString(), ruling: null }),
        history: [...b.history, { at: new Date().toISOString(), event: "disputed", by }] });
      return get(bountyId);
    },

    // Committee ruling: "release" pays the claimant (fee on payout); "refund"
    // returns the poster with zero fee (no payout happened — BountyEscrow rule).
    // Refund execution, like release, is PENDING_SETTLEMENT.
    resolveDispute(bountyId, { ruling }) {
      const b = get(bountyId);
      requireState(b, "disputed");
      check(ruling === "release" || ruling === "refund", "invalid_input", 'ruling must be "release"|"refund"');
      const gross = BigInt(b.amountRaw);
      let payout;
      if (ruling === "release") {
        check(b.claim, "invalid_input", "cannot release to a bounty with no claimant");
        const fee = (gross * BigInt(feeBps)) / 10000n;
        payout = Object.freeze({
          bountyId: b.bountyId, currency: "USDC", chain: b.chain, asset: b.asset,
          to: b.claim.payoutAddress,
          payeeNetRaw: (gross - fee).toString(), protocolFeeRaw: fee.toString(),
          protocolFeeBps: feeBps, via: "dispute_release", terms: b.terms,
          execution: "PENDING_SETTLEMENT",
        });
      } else {
        payout = Object.freeze({
          bountyId: b.bountyId, currency: "USDC", chain: b.chain, asset: b.asset,
          to: "poster", posterAddress: "(resolved at payout time from the poster's agent card)",
          payeeNetRaw: gross.toString(), protocolFeeRaw: "0",
          protocolFeeBps: feeBps, via: "dispute_refund", terms: b.terms,
          execution: "PENDING_SETTLEMENT",
        });
      }
      // M-17: settler first, terminal commit second — same reasoning as
      // release(): a throwing settler leaves the bounty "disputed"
      // (retryable) instead of recorded-and-lost.
      if (onPayout) onPayout(payout);
      set({ ...b, state: "resolved", payout,
        dispute: Object.freeze({ ...b.dispute, ruling, resolvedAt: new Date().toISOString() }),
        history: [...b.history, { at: new Date().toISOString(), event: `dispute_${ruling}`, by: "committee" }] });
      return payout;
    },

    get(bountyId) { return get(bountyId); },
    list() { return [...bounties.values()]; },
  };
}

export { UsdcRailError, CHAINS, DEFAULT_FEE_BPS, MAX_FEE_BPS };
