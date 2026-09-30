// usdc-x402 bridge tests — authoring gate answers:
// 1. Contracts guarded: room USDC rail payout -> x402 paymentRequirements mapping;
//    chain-name mapping (room "solana" -> x402 "solana", never mislabeled devnet);
//    raw-unit amount integrity; fee split into a second leg ONLY with a configured
//    fee address; refusal of placeholder refund addresses (dispute-refund "poster");
//    the PENDING_OWNER_TAP envelope (the bridge never executes anything).
// 2. Credible regressions: rail renames a chain; release emits floats; someone passes
//    the dispute-refund placeholder through; a fee leg generated to an unconfigured
//    or zero address; the PENDING_OWNER_TAP marker dropped or weakened.
// 3. Existing coverage does not catch it: usdc-payouts.test.js covers the rail's own
//    payout shape (PENDING_SETTLEMENT); the prototype's tests cover
//    paymentRequirements in isolation. Neither covers the room->x402 mapping
//    decisions. New module, owns its boundary.
// 4. No production seam: pure functions over the payout object; the rail's onPayout
//    callback is the only composition point.
import test from "node:test";
import assert from "node:assert/strict";
import { createUsdcRail } from "../server/usdc-payouts.mjs";
import { x402PayoutInstruction, x402OnPayout, X402BridgeError, RAIL_TO_X402_CHAIN } from "../server/usdc-x402.mjs";
import { CHAINS as X402_CHAINS } from "../server/x402.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof X402BridgeError && e.code === code);

const EVM_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const EVM_FEE = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SOL_ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3LuvCKZYJJ6gM4R9cT";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Drive the real rail to a released payout (1_000_000 raw = 1 USDC, 2% fee).
function releasedPayout({ chain = "base", addr = EVM_ADDR, amountRaw = "1000000", feeBps = 200 } = {}) {
  let captured = null;
  const rail = createUsdcRail({
    config: { protocolFeeBps: feeBps },
    onPayout: (p) => { captured = p; },
  });
  rail.post({ bountyId: "b1", poster: "alice", amountRaw, title: "fix bug", chain });
  rail.fund("b1", { by: "alice", fundTxRef: "tx_1" });
  rail.claim("b1", { claimant: "bob", payoutAddress: addr });
  rail.verify("b1", { verifier: "carol", receiptId: "rcpt_1", approved: true });
  rail.release("b1");
  return captured; // the rail's own payout object
}

test("base release -> single payee leg with exact x402 requirements", () => {
  const ix = x402PayoutInstruction({ payout: releasedPayout() });
  assert.equal(ix.kind, "x402-payout-instruction/v1");
  assert.equal(ix.execution, "PENDING_OWNER_TAP");
  assert.equal(ix.executedAt, null);
  assert.equal(ix.legs.length, 1);
  const leg = ix.legs[0];
  assert.equal(leg.kind, "payee");
  assert.equal(leg.payTo, EVM_ADDR);
  const r = leg.requirements;
  assert.equal(r.scheme, "exact");
  assert.equal(r.network, "base");
  assert.equal(r.asset, BASE_USDC);
  assert.equal(r.amount, "980000"); // 1_000_000 - 2% fee, recomputed independently below
  assert.equal(r.payTo, EVM_ADDR);
  assert.equal(r.resource, "project-room:bounty:b1");
  assert.equal(r.maxTimeoutSecs, 300);
  assert.equal(r.extra.authScheme, "eip3009");
  assert.ok(Object.isFrozen(ix));
  assert.ok(Object.isFrozen(leg.requirements));
});

test("fee math: net + fee == gross, recomputed independently", () => {
  const gross = 1000000n;
  const ix = x402PayoutInstruction({ payout: releasedPayout(), feeAddress: EVM_FEE });
  assert.equal(BigInt(ix.payeeNetRaw) + BigInt(ix.protocolFeeRaw), gross);
  assert.equal(ix.protocolFeeRaw, ((gross * 200n) / 10000n).toString()); // 20000
  assert.equal(ix.payeeNetRaw, (gross - (gross * 200n) / 10000n).toString()); // 980000
});

test("configured fee address -> second protocol-fee leg", () => {
  const ix = x402PayoutInstruction({
    payout: releasedPayout(),
    feeAddress: EVM_FEE,
    facilitator: "coinbase",
    maxTimeoutSecs: 600,
  });
  assert.equal(ix.legs.length, 2);
  const feeLeg = ix.legs[1];
  assert.equal(feeLeg.kind, "protocol-fee");
  assert.equal(feeLeg.payTo, EVM_FEE);
  assert.equal(feeLeg.requirements.amount, "20000");
  assert.equal(feeLeg.requirements.network, "base");
  assert.equal(feeLeg.requirements.facilitator, "coinbase");
  assert.equal(feeLeg.requirements.maxTimeoutSecs, 600);
  assert.equal(feeLeg.requirements.resource, "project-room:bounty:b1");
  assert.equal(ix.feeAddress, EVM_FEE);
});

test("unconfigured fee address -> no fee leg, fee recorded not invented", () => {
  const ix = x402PayoutInstruction({ payout: releasedPayout() });
  assert.equal(ix.legs.length, 1); // fee is 20000 but no destination: no leg
  assert.equal(ix.protocolFeeRaw, "20000");
  assert.equal(ix.feeAddress, null);
});

test("zero fee -> no fee leg even with a fee address", () => {
  const ix = x402PayoutInstruction({
    payout: releasedPayout({ feeBps: 0 }),
    feeAddress: EVM_FEE,
  });
  assert.equal(ix.legs.length, 1);
  assert.equal(ix.protocolFeeRaw, "0");
  assert.equal(ix.payeeNetRaw, "1000000");
});

test("room solana maps to x402 solana — never mislabeled devnet", () => {
  assert.equal(RAIL_TO_X402_CHAIN.solana, "solana");
  const ix = x402PayoutInstruction({ payout: releasedPayout({ chain: "solana", addr: SOL_ADDR }) });
  const r = ix.legs[0].requirements;
  assert.equal(r.network, "solana");
  assert.notEqual(r.network, "solana-devnet");
  assert.equal(r.asset, SOL_USDC);
  assert.equal(r.extra.authScheme, "solana-transfer");
  assert.equal(X402_CHAINS.solana.usdc, SOL_USDC);
});

test("dispute-refund placeholder address is refused, never wrapped in x402", () => {
  let refundPayout = null;
  const rail = createUsdcRail({ onPayout: (p) => { refundPayout = p; } });
  rail.post({ bountyId: "b2", poster: "alice", amountRaw: "500000", title: "t", chain: "base" });
  rail.fund("b2", { by: "alice", fundTxRef: "tx_1" });
  rail.dispute("b2", { by: "alice", reason: "no work" });
  rail.resolveDispute("b2", { ruling: "refund" });
  assert.equal(refundPayout.to, "poster"); // placeholder, not an address
  throwsCode(() => x402PayoutInstruction({ payout: refundPayout }), "invalid_input");
});

test("malformed payout fields fail closed", () => {
  const good = releasedPayout();
  throwsCode(() => x402PayoutInstruction({ payout: { ...good, to: "0xshort" } }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({ payout: { ...good, chain: "ethereum" } }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({ payout: { ...good, payeeNetRaw: "98.5" } }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({ payout: { ...good, payeeNetRaw: "0", protocolFeeRaw: "0" } }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({ payout: { ...good, currency: "credits" } }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({ payout: { ...good, asset: "0xdead" } }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({ payout: good, feeAddress: "not-an-address" }), "invalid_input");
  throwsCode(() => x402PayoutInstruction({}), "invalid_input");
  throwsCode(() => x402PayoutInstruction(), "invalid_input");
});

test("x402OnPayout composes with the rail: release emits the instruction", () => {
  let captured = null;
  const rail = createUsdcRail({
    // The callback's return is ignored by the rail; capture the instruction it builds.
    onPayout: (p) => { captured = x402OnPayout({ feeAddress: EVM_FEE })(p); },
  });
  rail.post({ bountyId: "b3", poster: "alice", amountRaw: "2000000", title: "t", chain: "base" });
  rail.fund("b3", { by: "alice", fundTxRef: "tx_9" });
  rail.claim("b3", { claimant: "bob", payoutAddress: EVM_ADDR });
  rail.verify("b3", { verifier: "carol", receiptId: "rcpt_9", approved: true });
  rail.release("b3");
  assert.equal(captured.kind, "x402-payout-instruction/v1");
  assert.equal(captured.execution, "PENDING_OWNER_TAP");
  assert.equal(captured.legs.length, 2);
  assert.equal(captured.legs[0].requirements.amount, "1960000");
  assert.equal(captured.legs[1].requirements.amount, "40000");
  assert.equal(captured.receiptId, "rcpt_9");
});
