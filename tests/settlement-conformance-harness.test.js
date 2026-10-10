// Adapter conformance harness (200-hard-tasks #15).
// The canonical shared test suite every settlement adapter must pass:
// fund, accept, release, refund, duplicate-event, wrong-amount, wrong-asset.
// Exported as certifyAdapter so future legs (and the adapter certification
// procedure in research/ADAPTER-CERTIFICATION.md) can certify a new chain
// adapter by calling it with a factory and an envelope factory.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const receiptFor = (env) => ({
  signature: "sig-" + env.id,
  jobId: env.jobId,
  amountRaw: env.chain.amountRaw,
  verifiedAtIso: new Date().toISOString(),
});

// makeAdapter: () => SettlementAdapter instance
// makeEnvelope: (jobIdSuffix) => valid envelope for that adapter's leg
export function certifyAdapter(legName, makeAdapter, makeEnvelope) {
  describe(`${legName} conformance certification`, () => {
    it("fund: accepts a valid envelope and emits funded", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("fund");
      const rec = adapter.fund(env, env.chain.amountRaw);
      assert.equal(rec.status, "funded");
      assert.equal(rec.amountRaw, env.chain.amountRaw);
      assert.equal(adapter.events().at(-1).type, "funded");
    });

    it("accept: moves funded -> accepted", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("accept");
      adapter.fund(env, env.chain.amountRaw);
      assert.equal(adapter.accept(env.id).status, "accepted");
    });

    it("release: moves accepted -> released with receipt evidence", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("release");
      adapter.fund(env, env.chain.amountRaw);
      adapter.accept(env.id);
      const released = adapter.release(env.id, receiptFor(env));
      assert.equal(released.status, "released");
      assert.deepEqual(adapter.events().map((e) => e.type), ["funded", "accepted", "released"]);
    });

    it("refund: returns funds to the payer with an audit trail", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("refund");
      adapter.fund(env, env.chain.amountRaw);
      const refunded = adapter.refund(env.id, "buyer cancelled");
      assert.equal(refunded.status, "refunded");
      assert.ok(adapter.events().some((e) => e.type === "refunded"));
    });

    it("duplicate-event: a replayed fund does not double-book", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("dup");
      const first = adapter.fund(env, env.chain.amountRaw);
      const second = adapter.fund(env, env.chain.amountRaw);
      assert.equal(second.duplicate, true);
      assert.equal(first.id, second.id);
      assert.equal(adapter.events().filter((e) => e.type === "funded").length, 1);
    });

    it("wrong-amount: a tampered amount against the agreed amount is rejected", () => {
      const adapter = makeAdapter();
      const agreed = makeEnvelope("amt");
      const tampered = { ...agreed, chain: { ...agreed.chain, amountRaw: "1" } };
      assert.throws(() => adapter.fund(tampered, agreed.chain.amountRaw), /wrong-amount/);
    });

    it("wrong-asset: an unregistered mint on the leg is rejected", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("asset");
      const fake = {
        ...env,
        chain: { ...env.chain, asset: { ...env.chain.asset, mint: "FakeMint11111111111111111111111111111" } },
      };
      assert.throws(() => adapter.fund(fake, env.chain.amountRaw), /wrong-asset|ENVELOPE_INVALID/);
    });

    it("wrong-chain: a cross-leg envelope is rejected", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("chain");
      const cross = { ...env, chain: { ...env.chain, id: "some-other-chain" } };
      assert.throws(() => adapter.fund(cross), /wrong-chain|unknown chain|ENVELOPE_INVALID/);
    });

    it("release requires receipt evidence; illegal transitions fail", () => {
      const adapter = makeAdapter();
      const env = makeEnvelope("trans");
      adapter.fund(env, env.chain.amountRaw);
      assert.throws(() => adapter.release(env.id, { signature: "x" }), /cannot move funded -> released/);
      adapter.accept(env.id);
      assert.throws(() => adapter.release(env.id, null), /release requires receipt/);
    });
  });
}
