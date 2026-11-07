// tests/demigod-ledger-pins.test.js — B1-2 mutation-audit PIN tests.
//
// Landed from the methods audit (wave-2026-10-26-methods-audit, phase-b/B1,
// B1-2): each test below is a distinguishing test that PASSES on the
// pristine code and FAILS on the named surviving mutant of
// server/settlement-router.mjs / server/fee-credit-ledger.mjs — mutants the
// existing oracle (tests/demigod-jobs-money.test.js) ran green on.
// Assertions are the audit's, unweakened.
//
// F1 note (owner decision, recorded here and in the PR body): D7 pins the
// CURRENT expiry semantics — a credit is usable at the exact expiry
// instant (T0 + 180 days), because both ledger sites compare with `>`.
// Whether the boundary should be `>` or `>=` is an unrecorded policy
// decision for the owner; this PR pins the semantics as-is and does NOT
// change them.
import test from "node:test";
import assert from "node:assert/strict";
import { routeSettlement, CUSTODY_REQUIREMENTS } from "../server/settlement-router.mjs";
import { createFeeCreditLedger } from "../server/fee-credit-ledger.mjs";
import { minorString } from "../server/minor-units.mjs";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86400000;
const makeLedger = (start = T0) => {
  let nowMs = start;
  const ledger = createFeeCreditLedger({ now: () => nowMs });
  return { ledger, setNow: (ms) => (nowMs = ms) };
};

// --- F3 CURE leg: the shared minor-unit validator (one helper, one pin) ---
test("F3 pin: shared minorString validator rejects the empty string", () => {
  assert.throws(() => minorString("", "amountMinor"), /amountMinor/);
  assert.throws(() => minorString("1.5", "amountMinor"), TypeError);
  assert.throws(() => minorString("-5", "amountMinor"), TypeError);
  assert.throws(() => minorString("abc", "amountMinor"), TypeError);
  assert.throws(() => minorString(5, "amountMinor"), TypeError);
  assert.equal(minorString("0", "amountMinor"), "0");
  assert.equal(minorString("200", "amountMinor"), "200");
});

test("D1/R06 router: empty amountMinor is rejected", () => {
  assert.throws(() => routeSettlement({ venue: "v", amountMinor: "", rail: "x" }), /amountMinor/);
});
test("D1/F04 ledger: empty feeMinor is rejected", () => {
  const { ledger } = makeLedger();
  assert.throws(() => ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "" }), /feeMinor/);
});
test("D2/R09 record-only return carries custodyEnabled:false", () => {
  const out = routeSettlement({ venue: "v", amountMinor: "1", rail: "x" });
  assert.equal(out.custodyEnabled, false);
});
test("D3/R15 CUSTODY_REQUIREMENTS is frozen", () => {
  assert.ok(Object.isFrozen(CUSTODY_REQUIREMENTS));
  assert.throws(() => CUSTODY_REQUIREMENTS.push("x"), TypeError);
});
test("D4/F06 invalid explicit expiresAt is a TypeError naming expiresAt", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "100" });
  assert.throws(
    () => ledger.applyCreditToPlacement({ clientId: "c1", placementId: "p1", trialTaskId: "t1", creditMinor: "1", expiresAt: "not-a-date" }),
    (e) => e instanceof TypeError && /expiresAt/.test(e.message),
  );
});
test("D5/F07 journal legs are frozen", () => {
  const { ledger } = makeLedger();
  const e = ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "100" });
  assert.throws(() => (e.legs[0].amountMinor = "0"), TypeError);
  assert.equal(ledger.entries()[0].legs[0].amountMinor, "100");
});
test("D6/F16-F19 leg account names and dc pairing are the ledger semantics", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200" });
  ledger.applyCreditToPlacement({ clientId: "c1", placementId: "p1", trialTaskId: "t1", creditMinor: "50" });
  const [fee, applied] = ledger.entries();
  assert.deepEqual(fee.legs.map((l) => [l.account, l.dc, l.amountMinor]), [
    ["client:c1:trial-fees-paid", "debit", "200"],
    ["client:c1:placement-credit", "credit", "200"],
  ]);
  assert.deepEqual(applied.legs.map((l) => [l.account, l.dc, l.amountMinor]), [
    ["client:c1:placement-credit", "debit", "50"],
    ["placement:p1:credits-redeemed", "credit", "50"],
  ]);
});
test("D7/F27 apply succeeds at the exact expiry instant", () => {
  const { ledger, setNow } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "100" });
  setNow(T0 + 180 * DAY); // exactly expiresAt
  const e = ledger.applyCreditToPlacement({ clientId: "c1", placementId: "p1", trialTaskId: "t1", creditMinor: "100" });
  assert.equal(e.type, "credit-applied");
});
test("D7/F32 balance still counts the fee at the exact expiry instant", () => {
  const { ledger, setNow } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "100" });
  setNow(T0 + 180 * DAY);
  assert.equal(ledger.creditBalance({ clientId: "c1" }), "100");
});
test("D8/F36 applied-key separator prevents cross-pair collision", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "ab", trialTaskId: "c", feeMinor: "100" });
  ledger.recordTrialFee({ clientId: "a", trialTaskId: "bc", feeMinor: "200" });
  ledger.applyCreditToPlacement({ clientId: "ab", placementId: "p1", trialTaskId: "c", creditMinor: "100" });
  // ("a","bc") was never applied: its credit must still be live.
  assert.equal(ledger.creditBalance({ clientId: "a" }), "200");
});
