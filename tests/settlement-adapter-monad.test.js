// Monad mock adapter lifecycle tests (200-hard-tasks #6).
// Contract guarded: the full job lifecycle fund -> accept -> release -> refund
// runs on the mock leg with envelope validation at fund time, and duplicate
// fund events do not double-book. Credible regression: a replayed fund event
// creating a second escrow record would double-spend the mock balance.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEnvelope, toRaw } from "../server/settlement-envelope.mjs";
import { createMonadAdapter, MONAD_MOCK_CHAIN_ID, MONAD_MOCK_USDC, mockEscrowCall } from "../server/settlement-adapter-monad.mjs";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function envelope(over = {}) {
  return createEnvelope({
    jobId: "job-monad-1",
    payer: "buyer:demo-01",
    payee: "provider:mac-mini-07",
    chainId: MONAD_MOCK_CHAIN_ID,
    assetMint: MONAD_MOCK_USDC,
    amountRaw: toRaw("0.05", 6),
    ...over,
  });
}

describe("monad mock adapter", () => {
  it("runs the full lifecycle fund -> accept -> release", () => {
    const adapter = createMonadAdapter();
    const env = envelope();
    const funded = adapter.fund(env);
    assert.equal(funded.status, "funded");
    const accepted = adapter.accept(env.id);
    assert.equal(accepted.status, "accepted");
    const receipt = { signature: "0xsig", jobId: env.jobId, amountRaw: env.chain.amountRaw };
    const released = adapter.release(env.id, receipt);
    assert.equal(released.status, "released");
    assert.deepEqual(adapter.events().map((e) => e.type), ["funded", "accepted", "released"]);
  });

  it("runs fund -> accept -> cancel -> refund with an audit trail", () => {
    const adapter = createMonadAdapter();
    const env = envelope({ jobId: "job-monad-2" });
    adapter.fund(env);
    adapter.accept(env.id);
    adapter.cancel(env.id, "provider no-show");
    const refunded = adapter.refund(env.id, "provider no-show");
    assert.equal(refunded.status, "refunded");
    assert.deepEqual(
      adapter.events().map((e) => e.type),
      ["funded", "accepted", "cancelled", "refunded"]
    );
  });

  it("rejects wrong-chain, wrong-asset and wrong-amount envelopes at fund", () => {
    const adapter = createMonadAdapter();
    assert.throws(() => adapter.fund(envelope({ chainId: "solana-mainnet", assetMint: USDC_SOL })), /wrong-chain/);
    assert.throws(() => adapter.fund(createEnvelope({
      jobId: "x", payer: "a", payee: "b",
      chainId: MONAD_MOCK_CHAIN_ID, assetMint: "0xdeadbeef", amountRaw: "1",
    })), /wrong-asset/);
    // tampered amount: envelope was built for 0.05 USDC; the gateway agrees 0.05,
    // but the submitted envelope says 999 microunits.
    const env = envelope();
    env.chain.amountRaw = "999";
    assert.throws(() => adapter.fund(env, toRaw("0.05", 6)), /wrong-amount/);
  });

  it("treats a duplicate fund event as a replay, not a second escrow", () => {
    const adapter = createMonadAdapter();
    const env = envelope({ jobId: "job-monad-dup" });
    const first = adapter.fund(env);
    const second = adapter.fund(env);
    assert.equal(second.duplicate, true);
    assert.equal(second.status, "funded");
    assert.equal(adapter.events().filter((e) => e.type === "funded").length, 1);
    assert.equal(first.id, second.id);
  });

  it("rejects illegal transitions and release without receipt", () => {
    const adapter = createMonadAdapter();
    const env = envelope({ jobId: "job-monad-ill" });
    adapter.fund(env);
    assert.throws(() => adapter.release(env.id, { signature: "x" }), /cannot move funded -> released/);
    adapter.accept(env.id);
    assert.throws(() => adapter.release(env.id, null), /release requires receipt/);
    assert.throws(() => adapter.accept("env_nonexistent"), /unknown escrow/);
  });

  it("records mock escrow calls for the real-leg replacement point", () => {
    const adapter = createMonadAdapter();
    const call = mockEscrowCall(adapter, "escrow.release", { id: "env_1" });
    assert.equal(call.mocked, true);
    assert.equal(call.chainId, MONAD_MOCK_CHAIN_ID);
    assert.equal(call.method, "escrow.release");
  });
});
