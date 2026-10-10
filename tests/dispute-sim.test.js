// Dispute-resolution simulator tests (200-hard-tasks #18).
// Contract guarded: the arbiter scores evidence with credibility weights
// (signed artifacts dominate bare claims), forfeits no-shows with a
// penalty, splits narrow margins, and conserves the escrowed amount
// (buyer + provider payouts == amount; penalty is separate stake).
// Credible regression: if credibility were ever flattened (all kinds
// equal), the garbage-delivery scenario would flip to the provider;
// the scenario assertions pin the weighting.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDispute,
  runAllScenarios,
  scenarioNonDeliveryWithProof,
  scenarioGarbageDelivery,
  scenarioAmbiguousQuality,
  scenarioProviderNoShow,
} from "../scripts/simulate-disputes.mjs";

describe("dispute simulator", () => {
  it("non-delivery claim vs signed receipt + delivery proof -> provider wins", () => {
    const r = scenarioNonDeliveryWithProof();
    assert.equal(r.ruling, "provider-wins");
    assert.equal(r.providerPayoutRaw, "100000");
    assert.equal(r.buyerPayoutRaw, "0");
  });

  it("garbage delivery with canary records -> buyer wins", () => {
    const r = scenarioGarbageDelivery();
    assert.equal(r.ruling, "buyer-wins");
    assert.equal(r.buyerPayoutRaw, "100000");
  });

  it("ambiguous quality -> split 50/50", () => {
    const r = scenarioAmbiguousQuality();
    assert.equal(r.ruling, "split");
    assert.equal(r.buyerPayoutRaw, "50000");
    assert.equal(r.providerPayoutRaw, "50000");
  });

  it("provider no-show -> buyer refunded + provider penalized", () => {
    const r = scenarioProviderNoShow();
    assert.equal(r.ruling, "provider-penalized");
    assert.equal(r.buyerPayoutRaw, "100000");
    assert.equal(r.penaltyRaw, "10000"); // 10% stake slash
  });

  it("frivolous buyer dispute (no buyer evidence) -> provider wins", () => {
    const d = createDispute({ disputeId: "dx", jobId: "j", envelopeId: "e", amountRaw: "100000", openedBy: "buyer", reason: "changed mind", seed: 5 });
    d.submitEvidence({ side: "provider", kind: "signed-receipt", weight: 1 });
    const r = d.rule();
    assert.equal(r.ruling, "provider-wins");
  });

  it("no evidence at all -> buyer refunded (nothing proven)", () => {
    const d = createDispute({ disputeId: "dy", jobId: "j", envelopeId: "e", amountRaw: "100000", openedBy: "provider", reason: "test", seed: 5 });
    const r = d.rule();
    assert.equal(r.ruling, "buyer-wins");
    assert.equal(r.buyerPayoutRaw, "100000");
  });

  it("payouts conserve the escrowed amount in every scenario", () => {
    const all = runAllScenarios();
    for (const [name, r] of Object.entries(all)) {
      const total = BigInt(r.buyerPayoutRaw) + BigInt(r.providerPayoutRaw);
      assert.equal(total.toString(), "100000", `${name}: payouts ${total} != 100000`);
    }
  });

  it("evidence window closes after ruling; bad inputs rejected", () => {
    const d = createDispute({ disputeId: "dz", jobId: "j", envelopeId: "e", amountRaw: "100", openedBy: "buyer", reason: "r", seed: 5 });
    assert.throws(() => d.submitEvidence({ side: "buyer", kind: "telepathy", weight: 1 }), /unknown evidence kind/);
    assert.throws(() => d.submitEvidence({ side: "buyer", kind: "unsigned-claim", weight: 0 }), /weight must be > 0/);
    d.submitEvidence({ side: "buyer", kind: "unsigned-claim", weight: 1 });
    d.rule();
    assert.throws(() => d.submitEvidence({ side: "buyer", kind: "unsigned-claim", weight: 1 }), /cannot submit evidence/);
    assert.throws(() => d.rule(), /already ruled/);
    assert.throws(() => createDispute({ disputeId: "dw", jobId: "j", envelopeId: "e", amountRaw: "1", openedBy: "mallory", reason: "r" }), /buyer\|provider/);
  });
});
