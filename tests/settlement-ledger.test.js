// Settlement ledger + reconciler tests (200-hard-tasks #14).
// Contract guarded: the off-chain ledger records deposits/claims/refunds/
// fees per epoch with exact BigInt totals, the reconciler flags all three
// mismatch classes against mocked chain data, and epoch close-out is
// blocked while mismatches exist. Credible regression: if the reconciler
// ever matched on jobId alone (ignoring txRef), a duplicate-tx replay
// would reconcile clean; the tamper/drop/extra cases pin the full key.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openLedger } from "../server/settlement-ledger.mjs";
import { reconcileEpoch, mockChainData } from "../scripts/ledger-reconcile.mjs";

function seedLedger() {
  const ledger = openLedger();
  ledger.openEpoch("epoch-1");
  const entries = [
    { epochId: "epoch-1", kind: "deposit", jobId: "j1", chainId: "monad", assetMint: "0xUSDC", amountRaw: "5000000", txRef: "0xd1" },
    { epochId: "epoch-1", kind: "claim", jobId: "j1", chainId: "monad", assetMint: "0xUSDC", amountRaw: "4750000", txRef: "0xc1" },
    { epochId: "epoch-1", kind: "fee", jobId: "j1", chainId: "monad", assetMint: "0xUSDC", amountRaw: "250000", txRef: "0xf1" },
    { epochId: "epoch-1", kind: "deposit", jobId: "j2", chainId: "monad", assetMint: "0xUSDC", amountRaw: "2000000", txRef: "0xd2" },
    { epochId: "epoch-1", kind: "refund", jobId: "j2", chainId: "monad", assetMint: "0xUSDC", amountRaw: "2000000", txRef: "0xr2" },
  ];
  for (const e of entries) ledger.record(e);
  return ledger;
}

describe("settlement ledger", () => {
  it("records entries and reports exact per-kind totals", () => {
    const ledger = seedLedger();
    try {
      const t = ledger.totals("epoch-1");
      assert.equal(t.deposit, "7000000");
      assert.equal(t.claim, "4750000");
      assert.equal(t.fee, "250000");
      assert.equal(t.refund, "2000000");
      // Conservation: deposits == claims + refunds + fees.
      assert.equal(BigInt(t.deposit), BigInt(t.claim) + BigInt(t.refund) + BigInt(t.fee));
    } finally {
      ledger.close();
    }
  });

  it("rejects bad kinds, bad amounts, unknown and closed epochs", () => {
    const ledger = openLedger();
    try {
      ledger.openEpoch("e1");
      assert.throws(() => ledger.record({ epochId: "e1", kind: "bribe", jobId: "j", chainId: "c", assetMint: "m", amountRaw: "1" }), /kind must be/);
      assert.throws(() => ledger.record({ epochId: "e1", kind: "deposit", jobId: "j", chainId: "c", assetMint: "m", amountRaw: "1.5" }), /integer string/);
      assert.throws(() => ledger.record({ epochId: "nope", kind: "deposit", jobId: "j", chainId: "c", assetMint: "m", amountRaw: "1" }), /does not exist/);
      ledger.closeEpoch("e1", () => ({ ok: true, mismatches: [] }));
      assert.throws(() => ledger.record({ epochId: "e1", kind: "deposit", jobId: "j", chainId: "c", assetMint: "m", amountRaw: "1" }), /is closed/);
    } finally {
      ledger.close();
    }
  });

  it("reconciler passes a clean epoch", () => {
    const ledger = seedLedger();
    try {
      const chain = mockChainData(ledger.entriesFor("epoch-1"));
      const r = reconcileEpoch(ledger, "epoch-1", chain);
      assert.equal(r.ok, true);
      assert.deepEqual(r.mismatches, []);
    } finally {
      ledger.close();
    }
  });

  it("flags missing-on-chain (phantom ledger booking)", () => {
    const ledger = seedLedger();
    try {
      const chain = mockChainData(ledger.entriesFor("epoch-1"), { dropTxRefs: ["0xd1"] });
      const r = reconcileEpoch(ledger, "epoch-1", chain);
      assert.equal(r.ok, false);
      assert.equal(r.mismatches.length, 1);
      assert.equal(r.mismatches[0].type, "missing-on-chain");
      assert.equal(r.mismatches[0].txRef, "0xd1");
    } finally {
      ledger.close();
    }
  });

  it("flags amount-mismatch (tampered or buggy booking)", () => {
    const ledger = seedLedger();
    try {
      const chain = mockChainData(ledger.entriesFor("epoch-1"), { tamper: { "0xc1": "1" } });
      const r = reconcileEpoch(ledger, "epoch-1", chain);
      assert.equal(r.ok, false);
      const m = r.mismatches.find((x) => x.type === "amount-mismatch");
      assert.ok(m);
      assert.equal(m.ledgerAmount, "4750000");
      assert.equal(m.chainAmount, "1");
    } finally {
      ledger.close();
    }
  });

  it("flags missing-in-ledger (unbooked on-chain movement)", () => {
    const ledger = seedLedger();
    try {
      const chain = mockChainData(ledger.entriesFor("epoch-1"), {
        extra: [{ kind: "claim", jobId: "j-ghost", chainId: "monad", assetMint: "0xUSDC", amountRaw: "999", txRef: "0xg1" }],
      });
      const r = reconcileEpoch(ledger, "epoch-1", chain);
      assert.equal(r.ok, false);
      const m = r.mismatches.find((x) => x.type === "missing-in-ledger");
      assert.ok(m);
      assert.equal(m.jobId, "j-ghost");
    } finally {
      ledger.close();
    }
  });

  it("epoch close-out is blocked while mismatches exist, and recorded on success", () => {
    const ledger = seedLedger();
    try {
      const badChain = mockChainData(ledger.entriesFor("epoch-1"), { dropTxRefs: ["0xf1"] });
      assert.throws(
        () => ledger.closeEpoch("epoch-1", (id) => reconcileEpoch(ledger, id, badChain)),
        /close-out blocked/
      );
      assert.equal(ledger.getEpoch("epoch-1").status, "open"); // still open
      const goodChain = mockChainData(ledger.entriesFor("epoch-1"));
      const closed = ledger.closeEpoch("epoch-1", (id) => reconcileEpoch(ledger, id, goodChain));
      assert.equal(closed.status, "closed");
      const recs = ledger.reconciliationsFor("epoch-1");
      assert.equal(recs.length, 2); // one failed attempt + one success, both journaled
      assert.equal(recs[0].ok, 0);
      assert.equal(recs[1].ok, 1);
    } finally {
      ledger.close();
    }
  });
});
