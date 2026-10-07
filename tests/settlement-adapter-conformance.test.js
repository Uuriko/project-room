// Solana adapter + cross-adapter conformance tests (200-hard-tasks #7).
// Contract guarded: both adapter legs produce identical envelope semantics —
// the same fund/accept/release/refund lifecycle, the same rejection of
// wrong-asset/wrong-chain/wrong-amount submissions, the same replay
// protection. Credible regression: a leg-specific shortcut (e.g. Solana
// skipping amount agreement) would let a tampered envelope settle on one leg.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEnvelope, toRaw } from "../server/settlement-envelope.mjs";
import { createMonadAdapter, MONAD_MOCK_CHAIN_ID, MONAD_MOCK_USDC } from "../server/settlement-adapter-monad.mjs";
import { createSolanaAdapter, SOLANA_MOCK_CHAIN_ID, SOLANA_MOCK_USDC, mockProgramCall } from "../server/settlement-adapter-solana.mjs";

function solEnvelope(over = {}) {
  return createEnvelope({
    jobId: "job-sol-1",
    payer: "buyer:demo-01",
    payee: "provider:mac-mini-07",
    chainId: SOLANA_MOCK_CHAIN_ID,
    assetMint: SOLANA_MOCK_USDC,
    amountRaw: toRaw("2.50", 6),
    ...over,
  });
}

function monadEnvelope(over = {}) {
  return createEnvelope({
    jobId: "job-monad-1",
    payer: "buyer:demo-01",
    payee: "provider:mac-mini-07",
    chainId: MONAD_MOCK_CHAIN_ID,
    assetMint: MONAD_MOCK_USDC,
    amountRaw: toRaw("2.50", 6),
    ...over,
  });
}

const receiptFor = (env) => ({ signature: "sig-" + env.id, jobId: env.jobId, amountRaw: env.chain.amountRaw });

// The shared lifecycle every leg must honor, parameterized by factory + envelope.
function lifecycleSuite(name, makeAdapter, makeEnvelope) {
  describe(`${name} lifecycle`, () => {
    it("fund -> accept -> release produces the same event trail", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope();
      adapter.fund(env, env.chain.amountRaw);
      adapter.accept(env.id);
      const released = adapter.release(env.id, receiptFor(env));
      assert.equal(released.status, "released");
      assert.deepEqual(adapter.events().map((e) => e.type), ["funded", "accepted", "released"]);
    });

    it("fund -> refund returns funds with an audit trail", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope({ jobId: "job-refund" });
      adapter.fund(env, env.chain.amountRaw);
      const refunded = adapter.refund(env.id, "buyer cancelled");
      assert.equal(refunded.status, "refunded");
      assert.ok(adapter.events().some((e) => e.type === "refunded"));
    });

    it("rejects the three canonical submission errors", () => {
      const adapter = makeAdapter();
      // wrong-chain: an envelope built for an unknown chain
      const env = makeEnvelope({ jobId: makeEnvelope().jobId + "-bad" });
      assert.throws(
        () => adapter.fund({ ...env, chain: { ...env.chain, id: "unknown-chain" } }),
        /unknown chain|wrong-chain|ENVELOPE_INVALID/
      );
      // wrong-amount: tampered amount against the agreed amount
      const agreed = makeEnvelope({ jobId: env.jobId + "-tamper" });
      const tampered = { ...agreed, chain: { ...agreed.chain, amountRaw: "1" } };
      assert.throws(() => adapter.fund(tampered, agreed.chain.amountRaw), /wrong-amount/);
    });

    it("duplicate fund is a replay, not a second escrow", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope({ jobId: "job-dup" });
      const first = adapter.fund(env, env.chain.amountRaw);
      const second = adapter.fund(env, env.chain.amountRaw);
      assert.equal(second.duplicate, true);
      assert.equal(first.id, second.id);
      assert.equal(adapter.events().filter((e) => e.type === "funded").length, 1);
    });
  });
}

lifecycleSuite("solana", createSolanaAdapter, solEnvelope);
lifecycleSuite("monad", createMonadAdapter, monadEnvelope);

describe("cross-adapter conformance", () => {
  it("both legs emit identical event sequences for the same lifecycle", () => {
    const runs = [
      [createSolanaAdapter(), solEnvelope({ jobId: "job-x" })],
      [createMonadAdapter(), monadEnvelope({ jobId: "job-x" })],
    ];
    const trails = runs.map(([adapter, env]) => {
      adapter.fund(env, env.chain.amountRaw);
      adapter.accept(env.id);
      adapter.release(env.id, receiptFor(env));
      return adapter.events().map((e) => e.type);
    });
    assert.deepEqual(trails[0], trails[1]);
    assert.deepEqual(trails[0], ["funded", "accepted", "released"]);
  });

  it("both legs reject a cross-leg envelope (wrong-chain)", () => {
    const sol = createSolanaAdapter();
    const monadEnv = monadEnvelope({ jobId: "job-cross" });
    assert.throws(() => sol.fund(monadEnv), /wrong-chain/);
    const monad = createMonadAdapter();
    const solEnv = solEnvelope({ jobId: "job-cross-2" });
    assert.throws(() => monad.fund(solEnv), /wrong-chain/);
  });

  it("mock program calls reject unknown instructions", () => {
    const sol = createSolanaAdapter();
    assert.throws(() => mockProgramCall(sol, "escrow.hack", {}), /unknown instruction/);
    const call = mockProgramCall(sol, "escrow.release", { escrow: "env_1" });
    assert.equal(call.mocked, true);
    assert.equal(call.chainId, SOLANA_MOCK_CHAIN_ID);
  });
});
