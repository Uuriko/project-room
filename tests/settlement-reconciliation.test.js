// Settlement reorg/reconciliation test matrix (200-hard-tasks #12).
// 14 cases covering duplicate chain events, reorgs, late attestations, and
// wrong-parameter submissions, exercised against the settlement stack
// (envelope validation, adapter lifecycle, two-level idempotency keys).
// Each case asserts the failure is contained: no double-payout, no
// double-book, no silent acceptance of a tampered submission.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEnvelope, toRaw } from "../server/settlement-envelope.mjs";
import { createMonadAdapter, MONAD_MOCK_CHAIN_ID, MONAD_MOCK_USDC } from "../server/settlement-adapter-monad.mjs";
import { deriveKey, deriveEventKey, createDedupStore, executeOnce } from "../server/idempotency.mjs";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function monadEnvelope(jobId, amountRaw = toRaw("1.00", 6)) {
  return createEnvelope({
    jobId, payer: "buyer:demo", payee: "provider:mac-1",
    chainId: MONAD_MOCK_CHAIN_ID, assetMint: MONAD_MOCK_USDC, amountRaw,
  });
}

// A miniature settlement journal: chain events in, payouts out, exactly once.
function createJournal() {
  const store = createDedupStore();
  const payouts = [];
  async function onChainEvent({ chainId, txHash, logIndex, jobId, amountRaw }) {
    const eventKey = deriveEventKey({ chainId, txHash, logIndex });
    const seen = await executeOnce(store, eventKey, async () => ({ noted: true }));
    if (seen.replayed) return { outcome: "duplicate-event", payouts: payouts.length };
    const intentKey = deriveKey({ scope: "payout", params: { jobId, amountRaw, chainId } });
    const payout = await executeOnce(store, intentKey, async () => {
      const tx = `0xpay-${payouts.length}`;
      payouts.push({ jobId, amountRaw, tx });
      return { tx };
    });
    return { outcome: payout.replayed ? "duplicate-intent" : "paid", payouts: payouts.length };
  }
  return { onChainEvent, payouts: () => payouts.slice() };
}

describe("settlement reconciliation matrix", () => {
  it("1. duplicate deposit event: same chain event twice -> one payout", async () => {
    const j = createJournal();
    const e = { chainId: MONAD_MOCK_CHAIN_ID, txHash: "0xaaa", logIndex: 0, jobId: "j-dup", amountRaw: toRaw("1.00", 6) };
    const r1 = await j.onChainEvent(e);
    const r2 = await j.onChainEvent(e);
    assert.equal(r1.outcome, "paid");
    assert.equal(r2.outcome, "duplicate-event");
    assert.equal(j.payouts().length, 1);
  });

  it("2. reorged payout: event re-included after a reorg -> still one payout", async () => {
    const j = createJournal();
    const e = { chainId: MONAD_MOCK_CHAIN_ID, txHash: "0xbbb", logIndex: 2, jobId: "j-reorg", amountRaw: toRaw("2.00", 6) };
    await j.onChainEvent(e); // included in block N
    // reorg: block N orphaned, event re-included in block N+1 with same txHash/logIndex
    const r = await j.onChainEvent(e);
    assert.equal(r.outcome, "duplicate-event");
    assert.equal(j.payouts().length, 1);
  });

  it("3. late CCTP attestation: attestation retried after timeout processes once", async () => {
    const store = createDedupStore();
    let attestations = 0;
    const key = deriveKey({ scope: "attestation", params: { transferId: "cctp-1" } });
    const first = await executeOnce(store, key, async () => {
      attestations++;
      return { status: "attested" };
    });
    assert.equal(first.replayed, false);
    // The relayer times out and retries the attestation 10 minutes later.
    const late = await executeOnce(store, key, async () => {
      attestations++;
      return { status: "attested" };
    });
    assert.equal(late.replayed, true);
    assert.equal(attestations, 1);
  });

  it("4. wrong asset: unregistered mint rejected at fund", () => {
    const adapter = createMonadAdapter();
    assert.throws(
      () => adapter.fund(createEnvelope({
        jobId: "j-wa", payer: "a", payee: "b", chainId: MONAD_MOCK_CHAIN_ID,
        assetMint: "0xdeadbeef", amountRaw: "100",
      })),
      /wrong-asset/
    );
  });

  it("5. wrong chain id: cross-leg envelope rejected at fund", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-wc");
    env.chain.id = "solana-mainnet";
    assert.throws(() => adapter.fund(env), /wrong-chain|unknown chain/);
  });

  it("6. wrong raw-unit amount: tampered amount vs agreed amount rejected", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-wm");
    const agreed = env.chain.amountRaw;
    env.chain.amountRaw = "1"; // tampered in flight
    assert.throws(() => adapter.fund(env, agreed), /wrong-amount/);
  });

  it("7. double refund: second refund rejected as illegal transition", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-dr");
    adapter.fund(env, env.chain.amountRaw);
    adapter.refund(env.id, "first");
    assert.throws(() => adapter.refund(env.id, "second"), /cannot move refunded/);
  });

  it("8. duplicate fund: replayed fund event does not double-book", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-df");
    const first = adapter.fund(env, env.chain.amountRaw);
    const second = adapter.fund(env, env.chain.amountRaw);
    assert.equal(second.duplicate, true);
    assert.equal(adapter.events().filter((e) => e.type === "funded").length, 1);
    assert.equal(first.id, second.id);
  });

  it("9. replacement transaction for the same job pays only once", async () => {
    const j = createJournal();
    const base = { chainId: MONAD_MOCK_CHAIN_ID, jobId: "j-replace", amountRaw: toRaw("3.00", 6) };
    await j.onChainEvent({ ...base, txHash: "0xc1", logIndex: 0 }); // original tx
    const r = await j.onChainEvent({ ...base, txHash: "0xc2", logIndex: 5 }); // replacement tx
    assert.equal(r.outcome, "duplicate-intent");
    assert.equal(j.payouts().length, 1);
  });

  it("10. release without receipt evidence rejected", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-nr");
    adapter.fund(env, env.chain.amountRaw);
    adapter.accept(env.id);
    assert.throws(() => adapter.release(env.id, null), /release requires receipt/);
  });

  it("11. settle-before-accept: release from funded (skipping accept) rejected", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-sa");
    adapter.fund(env, env.chain.amountRaw);
    assert.throws(() => adapter.release(env.id, { signature: "s" }), /cannot move funded -> released/);
  });

  it("12. unknown escrow id: operations on missing escrows fail closed", () => {
    const adapter = createMonadAdapter();
    assert.throws(() => adapter.accept("env_missing"), /unknown escrow/);
    assert.throws(() => adapter.refund("env_missing", "x"), /unknown escrow/);
  });

  it("13. wrong asset on a KNOWN chain: Solana mint on the Monad leg rejected", () => {
    const adapter = createMonadAdapter();
    const env = monadEnvelope("j-xa");
    env.chain.asset.mint = USDC_SOL; // real Solana USDC mint, wrong leg
    assert.throws(() => adapter.fund(env), /wrong-asset/);
  });

  it("14. zero and negative amounts rejected", () => {
    const adapter = createMonadAdapter();
    const zero = monadEnvelope("j-zero");
    zero.chain.amountRaw = "0";
    assert.throws(() => adapter.fund(zero, "0"), /wrong-amount/);
    const neg = monadEnvelope("j-neg");
    neg.chain.amountRaw = "-5";
    assert.throws(() => adapter.fund(neg, "-5"), /wrong-amount/);
  });
});
