// Escrow refund path tests (200-hard-tasks #13).
// Contract guarded: the full refund lifecycle — who can cancel, in which
// windows, pro-rata on partial completion — with BigInt-exact splits and a
// griefing scenario proving pre-accept cancellation is free and correct.
// Credible regression: float math on the pro-rata split would leak or mint
// dust; every split here asserts refundRaw + providerRaw == amountRaw exactly.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRefundPolicy } from "../server/escrow-refund.mjs";

const T0 = 1_700_000_000_000;
const policy = createRefundPolicy({ acceptWindowSec: 3600 });

describe("escrow refund policy", () => {
  it("cancel-before-accept: payer gets a full, fee-free refund", () => {
    const d = policy.assess({
      status: "funded", amountRaw: "50000", fundedAtMs: T0,
      actor: "payer", nowMs: T0 + 60_000,
    });
    assert.equal(d.allowed, true);
    assert.equal(d.code, "CANCEL_PRE_ACCEPT");
    assert.equal(d.refundRaw, "50000");
    assert.equal(d.providerRaw, "0");
  });

  it("cancel-after-partial: pro-rata split on evidenced progress, exact to the unit", () => {
    const d = policy.assess({
      status: "accepted", amountRaw: "50000", fundedAtMs: T0, acceptedAtMs: T0 + 1000,
      progressBps: 4000, actor: "payer", nowMs: T0 + 3600_000,
    });
    assert.equal(d.code, "PARTIAL_REFUND");
    assert.equal(d.providerRaw, "20000"); // 40% of 50000
    assert.equal(d.refundRaw, "30000");
    assert.equal(BigInt(d.refundRaw) + BigInt(d.providerRaw), 50000n);
  });

  it("partial split never leaks dust: odd amounts divide exactly", () => {
    const d = policy.assess({
      status: "accepted", amountRaw: "99999", fundedAtMs: T0, acceptedAtMs: T0 + 1000,
      progressBps: 3333, actor: "payer", nowMs: T0 + 3600_000,
    });
    assert.equal(BigInt(d.refundRaw) + BigInt(d.providerRaw), 99999n);
    assert.equal(d.providerRaw, ((99999n * 3333n) / 10000n).toString());
  });

  it("provider no-show: payer cancels after the accept window for a full refund", () => {
    const d = policy.assess({
      status: "funded", amountRaw: "50000", fundedAtMs: T0,
      actor: "payer", nowMs: T0 + 3601_000,
    });
    assert.equal(d.code, "NO_SHOW");
    assert.equal(d.refundRaw, "50000");
  });

  it("provider cannot no-show-cancel (only the payer can)", () => {
    assert.throws(
      () => policy.assess({ status: "funded", amountRaw: "50000", fundedAtMs: T0, actor: "provider", nowMs: T0 + 3601_000 }),
      /only the payer can no-show-cancel/
    );
  });

  it("provider default after accept: full refund, provider forfeits", () => {
    const d = policy.assess({
      status: "accepted", amountRaw: "50000", fundedAtMs: T0, acceptedAtMs: T0 + 1000,
      progressBps: 9000, actor: "provider", nowMs: T0 + 3600_000,
    });
    assert.equal(d.code, "PROVIDER_DEFAULT");
    assert.equal(d.refundRaw, "50000");
    assert.equal(d.providerRaw, "0");
  });

  it("payer cancel after accept without progress evidence fails closed (use dispute)", () => {
    assert.throws(
      () => policy.assess({ status: "accepted", amountRaw: "50000", fundedAtMs: T0, acceptedAtMs: T0 + 1000, actor: "payer", nowMs: T0 + 3600_000 }),
      /requires evidenced progressBps/
    );
  });

  it("cannot cancel from released/settled/refunded", () => {
    for (const status of ["released", "settled", "refunded"]) {
      assert.throws(
        () => policy.assess({ status, amountRaw: "1", fundedAtMs: T0, actor: "payer", nowMs: T0 }),
        /cannot cancel from .*?: funds already moved/
      );
    }
  });

  it("griefing: 5 pre-accept fund/cancel cycles are free, correct, and visible", () => {
    const ledger = policy.createGriefLedger();
    for (let i = 0; i < 5; i++) {
      const d = policy.assess({
        status: "funded", amountRaw: "50000", fundedAtMs: T0 + i * 1000,
        actor: "payer", nowMs: T0 + i * 1000 + 500,
      });
      // Free and correct: exactly the full amount back, provider earns nothing.
      assert.equal(d.refundRaw, "50000");
      assert.equal(d.providerRaw, "0");
      const g = ledger.record("payer:griefer", T0 + i * 1000 + 500);
      if (i < 4) assert.equal(g.flagged, false);
    }
    const last = ledger.record("payer:griefer", T0 + 5000 + 500);
    assert.equal(last.flagged, true); // visible at the strike threshold
    assert.equal(last.streak, 6);
    // ...but still free: the policy never deducts a penalty.
    const d = policy.assess({ status: "funded", amountRaw: "50000", fundedAtMs: T0 + 99999, actor: "payer", nowMs: T0 + 99999 + 500 });
    assert.equal(d.refundRaw, "50000");
  });

  it("rejects invalid progress and actors", () => {
    assert.throws(() => policy.assess({ status: "accepted", amountRaw: "1", fundedAtMs: T0, acceptedAtMs: T0, progressBps: 10001, actor: "payer", nowMs: T0 }), /progressBps/);
    assert.throws(() => policy.assess({ status: "funded", amountRaw: "1", fundedAtMs: T0, actor: "mallory", nowMs: T0 }), /actor must be/);
    assert.throws(() => policy.assess({ status: "funded", amountRaw: "0", fundedAtMs: T0, actor: "payer", nowMs: T0 }), /amountRaw/);
  });
});
