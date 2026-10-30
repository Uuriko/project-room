// fee-credit-expiry-pins.test.mjs — boundary pins for the fee-credit ledger's
// 180-day expiry instant. Filed by LAB wave Phase 2 lane E1 (mutation rig
// revival, 2026-10-30) in its lane package; NOT landed — the coordinator
// charters critic + PR assembly from the E1 report.
//
// PLACEMENT (when landed): tests/fee-credit-expiry-pins.test.mjs in
// Uuriko/project-room — this is the second suite of the mutation catalogue's
// `fee-credit-ledger` target, which joins the weekly set once this file lands.
//
// WHAT THIS PINS — CURRENT BEHAVIOUR, AS-IS:
//   server/fee-credit-ledger.mjs uses a strict `>` comparison on both expiry
//   paths:
//     - apply:   `if (clock() > Date.parse(effectiveExpiresAt)) throw …expired`
//     - balance: `if (nowMs > Date.parse(e.expiresAt)) continue; // expired`
//   So at EXACTLY the expiry instant (now == expiresAt) a credit is still
//   LIVE: the balance still counts it and an apply is ACCEPTED. It becomes
//   expired only 1 ms AFTER the instant.
//
// MUTANTS KILLED (catalogue v1.1, verified by E1 at lab pin 63534b92):
//   FC-01: apply  `>` → `>=`  (killed by the two apply-at-instant tests)
//   FC-02: balance `>` → `>=` (killed by the balance-at-instant test)
// Both mutants SURVIVED the full existing suite (23/23 green) in E1's rig
// run at the lab pin, and in the earlier DISCOVERY-50 F1 runs at 044da768 /
// cda3ccf3 — the holes are real, not equivalent mutants: each mutant changes
// observable behaviour at exactly one instant, and each pin fails on its
// mutant and passes on the pristine ledger (E1 execution evidence).
//
// WHAT THIS DOES NOT DECIDE: whether the instant SHOULD belong to the live
// side or the expired side is a policy question (recorded UNRESOLVED since
// DISCOVERY-50 F1). If that decision flips the semantics, flip the two
// comparisons and these pins with it — in the same change.
//
import test from "node:test";
import assert from "node:assert/strict";
import { createFeeCreditLedger } from "../server/fee-credit-ledger.mjs";

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

test("pin (FC-02): balance still counts the credit AT the exact expiry instant", () => {
  const { ledger, entry, setNow } = ledgerWithFee();
  const expiryMs = Date.parse(entry.expiresAt);
  setNow(expiryMs - 1);
  assert.equal(ledger.creditBalance({ clientId: "client-pin" }), "5000");
  setNow(expiryMs); // the exact 180-day instant: still live under strict `>`
  assert.equal(ledger.creditBalance({ clientId: "client-pin" }), "5000");
  setNow(expiryMs + 1); // 1 ms past the instant: expired
  assert.equal(ledger.creditBalance({ clientId: "client-pin" }), "0");
});

test("pin (FC-01): apply is ACCEPTED at the exact expiry instant, rejected 1 ms after", () => {
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

test("pin (FC-01, shortened expiry): apply at exactly the shortened expiresAt is ACCEPTED", () => {
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
  assert.equal(applied.type, "credit-applied");
});
