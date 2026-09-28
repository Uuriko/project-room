// USDC payout rail tests — authoring gate answers:
// 1. Contracts guarded: the rail gate (credits-only default — the load-bearing
//    boundary), the escrow lifecycle, fee-only-on-payout, PENDING_OWNER_TAP
//    (the module never moves money), payout-address format checks, illegal
//    transitions, and the fee cap.
// 2. Credible regressions: someone flips usdcEnabled default to true; fee math
//    changes; release starts executing transfers; dispute refund takes a fee.
// 3. No existing coverage: new module, owns its boundary.
// 4. No production seam: pure module, caller-owned store/config/callback.
import test from "node:test";
import assert from "node:assert/strict";
import { createUsdcRail, UsdcRailError, DEFAULT_FEE_BPS, MAX_FEE_BPS } from "../server/usdc-payouts.mjs";

const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e instanceof UsdcRailError && e.code === code);

const ENABLED = { usdcEnabled: true };
const EVM_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const SOL_ADDR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function posted(rail, id = "b1") {
  return rail.post({ bountyId: id, poster: "alice", amountRaw: "1000000", title: "fix bug", chain: "base" });
}
function toVerified(rail, id = "b1") {
  posted(rail, id);
  rail.fund(id, { by: "alice", fundTxRef: "tx_1" });
  rail.claim(id, { claimant: "bob", payoutAddress: EVM_ADDR, erc8004Identity: "8004:8453:7" });
  return rail.verify(id, { verifier: "carol", receiptId: "rcpt_1", approved: true });
}

test("rail gate: credits-only by default — every USDC op throws usdc_rail_disabled", () => {
  const rail = createUsdcRail(); // no config at all
  assert.equal(rail.railStatus().usdcEnabled, false);
  assert.equal(rail.railStatus().currency, "credits");
  throwsCode(() => rail.post({ bountyId: "b1", poster: "a", amountRaw: "1", title: "t" }), "usdc_rail_disabled");
  throwsCode(() => rail.fund("b1", { by: "a", fundTxRef: "x" }), "usdc_rail_disabled");
  throwsCode(() => rail.release("b1"), "usdc_rail_disabled");
  throwsCode(() => rail.dispute("b1", { by: "a", reason: "r" }), "usdc_rail_disabled");
});

test("rail gate: explicit usdcEnabled:false is also credits-only", () => {
  const rail = createUsdcRail({ config: { usdcEnabled: false } });
  throwsCode(() => rail.post({ bountyId: "b1", poster: "a", amountRaw: "1", title: "t" }), "usdc_rail_disabled");
});

test("post carries disclosed terms: 2% default fee, fee-only-on-payout rule", () => {
  const rail = createUsdcRail({ config: ENABLED });
  const b = posted(rail);
  assert.equal(b.state, "posted");
  assert.equal(b.currency, "USDC");
  assert.equal(b.terms.protocolFeeBps, DEFAULT_FEE_BPS);
  assert.equal(DEFAULT_FEE_BPS, 200);
  assert.match(b.terms.feeRule, /ONLY on payout/);
  assert.equal(b.asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"); // Base USDC
});

test("protocol fee is room-configurable within the 10% cap", () => {
  const rail = createUsdcRail({ config: { usdcEnabled: true, protocolFeeBps: 50 } });
  assert.equal(posted(rail).terms.protocolFeeBps, 50);
  assert.throws(() => createUsdcRail({ config: { usdcEnabled: true, protocolFeeBps: MAX_FEE_BPS + 1 } }),
    (e) => e instanceof UsdcRailError && e.code === "invalid_input");
});

test("full lifecycle: post -> fund -> claim -> verify -> release; fee only on payout", () => {
  const payouts = [];
  const rail = createUsdcRail({ config: ENABLED, onPayout: (p) => payouts.push(p) });
  toVerified(rail);
  const p = rail.release("b1");
  assert.equal(rail.get("b1").state, "released");
  assert.equal(p.payeeNetRaw, "980000"); // 2% of 1,000,000
  assert.equal(p.protocolFeeRaw, "20000");
  assert.equal(p.to, EVM_ADDR);
  assert.equal(p.execution, "PENDING_OWNER_TAP"); // instruction only — John moves the money
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0], p);
});

test("claim validates the payout address format per chain", () => {
  const rail = createUsdcRail({ config: ENABLED });
  posted(rail);
  rail.fund("b1", { by: "alice", fundTxRef: "tx_1" });
  throwsCode(() => rail.claim("b1", { claimant: "bob", payoutAddress: "not-an-address" }), "invalid_input");
  throwsCode(() => rail.claim("b1", { claimant: "bob", payoutAddress: SOL_ADDR }), "invalid_input"); // sol addr on base
  const b = rail.claim("b1", { claimant: "bob", payoutAddress: EVM_ADDR });
  assert.equal(b.claim.payoutAddress, EVM_ADDR);
});

test("solana bounties use the Solana USDC mint and base58 addresses", () => {
  const rail = createUsdcRail({ config: ENABLED });
  const b = rail.post({ bountyId: "s1", poster: "alice", amountRaw: "5000000", title: "t", chain: "solana" });
  assert.equal(b.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  rail.fund("s1", { by: "alice", fundTxRef: "tx_s" });
  const c = rail.claim("s1", { claimant: "bob", payoutAddress: SOL_ADDR });
  assert.equal(c.claim.payoutAddress, SOL_ADDR);
});

test("verifier must be distinct from the claimant (separation of duties)", () => {
  const rail = createUsdcRail({ config: ENABLED });
  posted(rail);
  rail.fund("b1", { by: "alice", fundTxRef: "tx_1" });
  rail.claim("b1", { claimant: "bob", payoutAddress: EVM_ADDR });
  throwsCode(() => rail.verify("b1", { verifier: "bob", receiptId: "r", approved: true }), "verifier_conflict");
});

test("rejected verification returns the bounty to funded (claimant can re-submit)", () => {
  const rail = createUsdcRail({ config: ENABLED });
  posted(rail);
  rail.fund("b1", { by: "alice", fundTxRef: "tx_1" });
  rail.claim("b1", { claimant: "bob", payoutAddress: EVM_ADDR });
  const b = rail.verify("b1", { verifier: "carol", receiptId: "r", approved: false });
  assert.equal(b.state, "funded");
  assert.equal(b.claim, null);
});

test("dispute freezes a funded bounty; committee release pays, refund takes no fee", () => {
  const rail = createUsdcRail({ config: ENABLED });
  posted(rail, "d1");
  rail.fund("d1", { by: "alice", fundTxRef: "tx_1" });
  rail.dispute("d1", { by: "alice", reason: "no deliverable" });
  assert.equal(rail.get("d1").state, "disputed");
  // release path needs a claimant first
  assert.throws(() => rail.resolveDispute("d1", { ruling: "release" }), /no claimant/);
  const refund = rail.resolveDispute("d1", { ruling: "refund" });
  assert.equal(refund.payeeNetRaw, "1000000");
  assert.equal(refund.protocolFeeRaw, "0"); // no payout happened — no fee (BountyEscrow rule)
  assert.equal(refund.execution, "PENDING_OWNER_TAP");
  assert.equal(rail.get("d1").state, "resolved");
});

test("illegal transitions are rejected", () => {
  const rail = createUsdcRail({ config: ENABLED });
  posted(rail);
  throwsCode(() => rail.claim("b1", { claimant: "b", payoutAddress: EVM_ADDR }), "invalid_transition"); // not funded
  throwsCode(() => rail.release("b1"), "invalid_transition"); // not verified
  throwsCode(() => rail.dispute("b1", { by: "a", reason: "r" }), "invalid_transition"); // not funded
  throwsCode(() => rail.fund("b1", { by: "mallory", fundTxRef: "x" }), "not_poster");
});

test("amounts are raw-unit integer strings — floats rejected", () => {
  const rail = createUsdcRail({ config: ENABLED });
  for (const bad of ["1.5", "0x10", "-1", "1,000", ""]) {
    throwsCode(() => rail.post({ bountyId: `b-${bad}`, poster: "a", amountRaw: bad, title: "t" }), "invalid_input");
  }
});
