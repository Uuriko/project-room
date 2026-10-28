// fee-credit-expiry-pins.test.mjs — boundary pins for the fee-credit ledger's
// 180-day expiry instant (DISCOVERY-50 lane F1 gaps M07 + M12; DISCOVERY
// ADOPT-NOW item F1 recovery, 2026-10-27).
//
// WHAT THIS PINS — CURRENT BEHAVIOUR, AS-IS:
//   server/fee-credit-ledger.mjs uses a strict `>` comparison on both expiry
//   paths:
//     - apply:   `if (clock() > Date.parse(effectiveExpiresAt)) throw …expired`
//     - balance: `if (nowMs > Date.parse(e.expiresAt)) continue; // expired`
//   So at EXACTLY the expiry instant (now == expiresAt) a credit is still
//   LIVE: the balance still counts it and an apply is ACCEPTED. It becomes
//   expired only 1 ms AFTER the instant. These tests lock that behaviour in.
//   They kill mutants M07 (apply `>` → `>=`) and M12 (balance `>` → `>=`),
//   both of which survived the full existing suite (23/23 green) in the
//   wave run at 044da768 and in the recovery re-run at tip cda3ccf3.
//
// WHAT THIS DOES NOT DECIDE:
//   Whether the instant SHOULD belong to the live side or the expired side
//   is a policy question for John / the sitting (recorded UNRESOLVED in the
//   methods-audit conversion: "whether a fee credit expires at the 180-day
//   instant or just after it"). If that decision flips the semantics, flip
//   these two comparisons and these pins with it — in the same change.
//
// PLACEMENT: this file is written to live at tests/fee-credit-expiry-pins.test.mjs
// in Uuriko/project-room (see fee-credit-expiry-pins.patch in this directory).
// No PR is authorised for this item, so it is filed as a patch, not landed.
// The FEE_CREDIT_LEDGER_PATH override exists only so the filed copy can be
// executed against a pristine tree / mutant copies before it lands; the
// default path is the repo placement and needs no override in-tree.
import test from "node:test";
import assert from "node:assert/strict";

const { createFeeCreditLedger } = await import(
  process.env.FEE_CREDIT_LEDGER_PATH ?? "../server/fee-credit-ledger.mjs"
);

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

// Records one fee at T0 on a controllable clock; returns the ledger, the
// recorded entry, and a setter for the clock.
function ledgerWithFee() {
  let nowMs = T0;
  const ledger = createFeeCreditLedger({ now: () => nowMs });
  const entry = ledger.recordTrialFee({
    clientId: "client-pin",
    trialTaskId: "trial-pin",
    feeMinor: "5000",
  });
  return { ledger, entry, setNow: (ms) => { nowMs = ms; } };
}

test("pin (M12): balance still counts the credit AT the exact expiry instant", () => {
  const { ledger, entry, setNow } = ledgerWithFee();
  const expiryMs = Date.parse(entry.expiresAt);
  setNow(expiryMs - 1);
  assert.equal(ledger.creditBalance({ clientId: "client-pin" }), "5000");
  setNow(expiryMs); // the exact 180-day instant: still live under strict `>`
  assert.equal(ledger.creditBalance({ clientId: "client-pin" }), "5000");
  setNow(expiryMs + 1); // 1 ms past the instant: expired
  assert.equal(ledger.creditBalance({ clientId: "client-pin" }), "0");
});

test("pin (M07): apply is ACCEPTED at the exact expiry instant, rejected 1 ms after", () => {
  const atInstant = ledgerWithFee();
  atInstant.setNow(Date.parse(atInstant.entry.expiresAt));
  const applied = atInstant.ledger.applyCreditToPlacement({
    clientId: "client-pin",
    placementId: "placement-pin",
    trialTaskId: "trial-pin",
    creditMinor: "5000",
  });
  assert.equal(applied.type, "credit-applied");
  assert.equal(atInstant.ledger.creditBalance({ clientId: "client-pin" }), "0");

  const pastInstant = ledgerWithFee();
  pastInstant.setNow(Date.parse(pastInstant.entry.expiresAt) + 1);
  assert.throws(
    () =>
      pastInstant.ledger.applyCreditToPlacement({
        clientId: "client-pin",
        placementId: "placement-pin",
        trialTaskId: "trial-pin",
        creditMinor: "5000",
      }),
    /credit expired/,
  );
});

test("pin (M07, shortened expiry): apply at exactly the shortened expiresAt is ACCEPTED", () => {
  const { ledger, entry, setNow } = ledgerWithFee();
  const shortened = new Date(T0 + 60_000).toISOString(); // 1 minute out, < fee expiry
  assert.ok(Date.parse(shortened) < Date.parse(entry.expiresAt));
  setNow(Date.parse(shortened)); // exact shortened instant: still live
  const applied = ledger.applyCreditToPlacement({
    clientId: "client-pin",
    placementId: "placement-pin",
    trialTaskId: "trial-pin",
    creditMinor: "5000",
    expiresAt: shortened,
  });
  assert.equal(applied.expiresAt, shortened);

  const past = ledgerWithFee();
  past.setNow(Date.parse(shortened) + 1);
  assert.throws(
    () =>
      past.ledger.applyCreditToPlacement({
        clientId: "client-pin",
        placementId: "placement-pin",
        trialTaskId: "trial-pin",
        creditMinor: "5000",
        expiresAt: shortened,
      }),
    /credit expired/,
  );
});
