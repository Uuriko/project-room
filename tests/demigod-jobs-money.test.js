// Demigod x Project Room jobs integration — money-policy modules, RECORD-ONLY.
//
// Failing-first tests for Lane D (build):
//   server/demigod-policy-adapter.mjs — placementFeeBreakdown / trialManagementFee
//   server/settlement-router.mjs      — routeSettlement (always record-only)
//   server/fee-credit-ledger.mjs      — Lemon.io-shaped trial-fee credit ledger
//
// Nothing here moves money. Every module under test COMPUTES what a fee would
// be; collection needs John's funding tap.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const headerOf = (rel) =>
  readFileSync(join(root, rel), "utf8").split("\n").slice(0, 20).join("\n");

const {
  placementFeeBreakdown,
  trialManagementFee,
  DEMIGOD_PLACEMENT_FEE_BPS,
  DEMIGOD_POLICY_VERSION,
} = await import("../server/demigod-policy-adapter.mjs");
const { CUSTODY_ENABLED, CUSTODY_REQUIREMENTS, routeSettlement } = await import(
  "../server/settlement-router.mjs"
);
const { createFeeCreditLedger, CREDIT_EXPIRY_DAYS } = await import(
  "../server/fee-credit-ledger.mjs"
);

// ---------------------------------------------------------------------------
// 0. RECORD-ONLY banner in every module header
// ---------------------------------------------------------------------------

test("every money-policy module carries RECORD-ONLY in its header comment", () => {
  for (const rel of [
    "server/demigod-policy-adapter.mjs",
    "server/settlement-router.mjs",
    "server/fee-credit-ledger.mjs",
  ]) {
    assert.match(headerOf(rel), /RECORD-ONLY/, `${rel} header must say RECORD-ONLY`);
  }
});

// ---------------------------------------------------------------------------
// 1. demigod-policy-adapter: placementFeeBreakdown
// ---------------------------------------------------------------------------

test("placement fee is exactly 1000 bps: table of known values", () => {
  const cases = [
    // [placementValueMinor, expectedFeeMinor, expectedNetMinor, note]
    ["100000", "10000", "90000", "10% of $1,000.00"],
    ["250000", "25000", "225000", "10% of $2,500.00"],
    ["0", "0", "0", "zero placement"],
    ["105", "10", "95", "non-divisible value floors the fee: 105*1000/10000 = 10.5 -> 10"],
    ["99999999999999999999", "9999999999999999999", "90000000000000000000", "exact past Number.MAX_SAFE_INTEGER"],
  ];
  for (const [placementValueMinor, feeMinor, netToTalentMinor, note] of cases) {
    const out = placementFeeBreakdown({ placementValueMinor, currency: "USD" });
    assert.equal(out.feeBps, "1000", note);
    assert.equal(out.feeMinor, feeMinor, note);
    assert.equal(out.netToTalentMinor, netToTalentMinor, note);
    assert.equal(out.policy, "demigod-placement/1", note);
    assert.equal(out.currency, "USD", note);
    assert.equal(
      BigInt(out.feeMinor) + BigInt(out.netToTalentMinor),
      BigInt(placementValueMinor),
      `fee + net reconstructs the placement value (${note})`,
    );
  }
  assert.equal(DEMIGOD_PLACEMENT_FEE_BPS, "1000");
  assert.equal(DEMIGOD_POLICY_VERSION, "demigod-placement/1");
});

test("all placement amounts are decimal strings", () => {
  const out = placementFeeBreakdown({ placementValueMinor: "100000", currency: "USD" });
  for (const k of ["feeBps", "feeMinor", "netToTalentMinor", "policy"]) {
    assert.equal(typeof out[k], "string", k);
  }
});

test("placementFeeBreakdown rejects bad inputs", () => {
  assert.throws(
    () => placementFeeBreakdown({ placementValueMinor: "-5", currency: "USD" }),
    /placementValueMinor/,
  );
  assert.throws(
    () => placementFeeBreakdown({ placementValueMinor: "abc", currency: "USD" }),
    /placementValueMinor/,
  );
  assert.throws(
    () => placementFeeBreakdown({ placementValueMinor: 100, currency: "USD" }),
    /placementValueMinor/,
  );
  assert.throws(
    () => placementFeeBreakdown({ placementValueMinor: "100", currency: "" }),
    /currency/,
  );
  assert.throws(
    () => placementFeeBreakdown({ placementValueMinor: "100" }),
    /currency/,
  );
});

// ---------------------------------------------------------------------------
// 2. demigod-policy-adapter: trialManagementFee
// ---------------------------------------------------------------------------

test("trial management fee is hours x rate, always creditable", () => {
  const cases = [
    // [trialHoursMax, hourlyRateMinor, expectedFeeMinor, note]
    [40, "5000", "200000", "40h x $50/hr = $2,000.00"],
    [0, "5000", "0", "zero hours"],
    ["10", "250", "2500", "string hours accepted"],
  ];
  for (const [trialHoursMax, hourlyRateMinor, feeMinor, note] of cases) {
    const out = trialManagementFee({ trialHoursMax, hourlyRateMinor });
    assert.equal(out.feeMinor, feeMinor, note);
    assert.equal(out.creditableAgainstPlacement, true, note);
    assert.equal(typeof out.feeMinor, "string", note);
  }
});

test("trialManagementFee rejects bad inputs", () => {
  assert.throws(
    () => trialManagementFee({ trialHoursMax: -1, hourlyRateMinor: "5000" }),
    /trialHoursMax/,
  );
  assert.throws(
    () => trialManagementFee({ trialHoursMax: 1.5, hourlyRateMinor: "5000" }),
    /trialHoursMax/,
  );
  assert.throws(
    () => trialManagementFee({ trialHoursMax: 40, hourlyRateMinor: "-5" }),
    /hourlyRateMinor/,
  );
  assert.throws(
    () => trialManagementFee({ trialHoursMax: 40, hourlyRateMinor: "5.00" }),
    /hourlyRateMinor/,
  );
});

// ---------------------------------------------------------------------------
// 3. settlement-router: custody is off by design
// ---------------------------------------------------------------------------

test("CUSTODY_ENABLED is false and the requirements name John's approvals", () => {
  assert.equal(CUSTODY_ENABLED, false);
  assert.ok(Array.isArray(CUSTODY_REQUIREMENTS));
  assert.equal(CUSTODY_REQUIREMENTS.length, 3);
  const joined = CUSTODY_REQUIREMENTS.join(" ").toLowerCase();
  assert.match(joined, /funded pool/);
  assert.match(joined, /collection authority/);
  assert.match(joined, /payout authority/);
});

test("routeSettlement always returns record-only, with a reason", () => {
  for (const args of [
    { venue: "demigod", amountMinor: "10000", rail: "usdc" },
    { venue: "project-room", amountMinor: "0", rail: "manual" },
    { venue: "demigod", amountMinor: "999999999999", rail: "ach" },
  ]) {
    const out = routeSettlement(args);
    assert.equal(out.route, "record-only");
    assert.equal(typeof out.reason, "string");
    assert.ok(out.reason.length > 0, "reason must be non-empty");
    assert.equal(out.venue, args.venue);
    assert.equal(out.amountMinor, args.amountMinor);
    assert.equal(out.rail, args.rail);
  }
});

test("routeSettlement rejects bad inputs", () => {
  assert.throws(() => routeSettlement({ venue: "", amountMinor: "1", rail: "x" }), /venue/);
  assert.throws(
    () => routeSettlement({ venue: "v", amountMinor: "1.5", rail: "x" }),
    /amountMinor/,
  );
  assert.throws(() => routeSettlement({ venue: "v", amountMinor: "1" }), /rail/);
});

// ---------------------------------------------------------------------------
// 4. fee-credit-ledger: Lemon.io shape, record-only double-entry
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 86400000;
const makeLedger = (start = T0) => {
  let nowMs = start;
  const ledger = createFeeCreditLedger({ now: () => nowMs });
  return { ledger, setNow: (ms) => (nowMs = ms) };
};

test("recordTrialFee stores a credit expiring 180 days out, as strings", () => {
  const { ledger } = makeLedger();
  const e = ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  assert.equal(e.type, "trial-fee");
  assert.equal(e.clientId, "c1");
  assert.equal(e.trialTaskId, "t1");
  assert.equal(e.feeMinor, "200000");
  assert.equal(e.recordedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(e.expiresAt, "2026-06-30T00:00:00.000Z"); // T0 + 180 days
  assert.equal(CREDIT_EXPIRY_DAYS, 180);
  assert.equal(typeof e.recordedAt, "string");
  assert.equal(typeof e.expiresAt, "string");
});

test("recording the same trial fee twice is rejected", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  assert.throws(
    () => ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" }),
    /already recorded|duplicate/i,
  );
});

test("same trialTaskId under a different client is a separate fee", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  const e = ledger.recordTrialFee({ clientId: "c2", trialTaskId: "t1", feeMinor: "100" });
  assert.equal(e.clientId, "c2");
});

test("applyCreditToPlacement records the credit and it counts once", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  const e = ledger.applyCreditToPlacement({
    clientId: "c1",
    placementId: "p1",
    trialTaskId: "t1",
    creditMinor: "200000",
  });
  assert.equal(e.type, "credit-applied");
  assert.equal(e.placementId, "p1");
  assert.equal(e.creditMinor, "200000");
  assert.equal(typeof e.appliedAt, "string");
});

test("double-apply of the same trial fee is rejected", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  ledger.applyCreditToPlacement({
    clientId: "c1",
    placementId: "p1",
    trialTaskId: "t1",
    creditMinor: "100000",
  });
  assert.throws(
    () =>
      ledger.applyCreditToPlacement({
        clientId: "c1",
        placementId: "p2",
        trialTaskId: "t1",
        creditMinor: "100000",
      }),
    /already applied/i,
  );
});

test("credit can never exceed the fee paid", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  assert.throws(
    () =>
      ledger.applyCreditToPlacement({
        clientId: "c1",
        placementId: "p1",
        trialTaskId: "t1",
        creditMinor: "200001",
      }),
    /exceed/i,
  );
  assert.throws(
    () =>
      ledger.applyCreditToPlacement({
        clientId: "c1",
        placementId: "p1",
        trialTaskId: "t1",
        creditMinor: "0",
      }),
    /creditMinor/,
  );
});

test("expired credits are not applied", () => {
  const { ledger, setNow } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  setNow(T0 + 181 * DAY); // past the 180-day expiry
  assert.throws(
    () =>
      ledger.applyCreditToPlacement({
        clientId: "c1",
        placementId: "p1",
        trialTaskId: "t1",
        creditMinor: "200000",
      }),
    /expired/i,
  );
});

test("apply-time expiresAt can only shorten the credit, never extend it", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  const shorter = new Date(T0 + 30 * DAY).toISOString();
  const e = ledger.applyCreditToPlacement({
    clientId: "c1",
    placementId: "p1",
    trialTaskId: "t1",
    creditMinor: "200000",
    expiresAt: shorter,
  });
  assert.equal(e.expiresAt, shorter);

  const { ledger: ledger2, setNow: setNow2 } = makeLedger();
  ledger2.recordTrialFee({ clientId: "c1", trialTaskId: "t9", feeMinor: "200000" });
  setNow2(T0 + 200 * DAY); // past the fee's own 180-day expiry
  assert.throws(
    () =>
      ledger2.applyCreditToPlacement({
        clientId: "c1",
        placementId: "p1",
        trialTaskId: "t9",
        creditMinor: "1",
        expiresAt: new Date(T0 + 400 * DAY).toISOString(), // extension attempt
      }),
    /expired/i,
  );
});

test("creditBalance is derived from the journal: unexpired, unapplied fees only", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "10000" });
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t2", feeMinor: "20000" });
  assert.equal(ledger.creditBalance({ clientId: "c1" }), "30000");
  // A trial fee's credit is single-use: one application consumes the whole
  // credit, so the remainder is forfeited and leaves the balance.
  ledger.applyCreditToPlacement({
    clientId: "c1",
    placementId: "p1",
    trialTaskId: "t1",
    creditMinor: "4000",
  });
  assert.equal(ledger.creditBalance({ clientId: "c1" }), "20000");
  assert.equal(ledger.creditBalance({ clientId: "nobody" }), "0");
});

test("expired fees contribute nothing to the balance", () => {
  const { ledger, setNow } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "10000" });
  assert.equal(ledger.creditBalance({ clientId: "c1" }), "10000");
  setNow(T0 + 181 * DAY);
  assert.equal(ledger.creditBalance({ clientId: "c1" }), "0");
});

test("every journal entry is balanced double-entry", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  ledger.applyCreditToPlacement({
    clientId: "c1",
    placementId: "p1",
    trialTaskId: "t1",
    creditMinor: "200000",
  });
  for (const e of ledger.entries()) {
    assert.ok(Array.isArray(e.legs) && e.legs.length >= 2, "entry carries legs");
    const debits = e.legs
      .filter((l) => l.dc === "debit")
      .reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    const credits = e.legs
      .filter((l) => l.dc === "credit")
      .reduce((s, l) => s + BigInt(l.amountMinor), 0n);
    assert.equal(debits, credits, `entry ${e.seq} must balance`);
    assert.ok(debits > 0n, "entry moves a positive amount");
  }
});

test("journal is append-only: callers get frozen copies, internal state is untouched", () => {
  const { ledger } = makeLedger();
  ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "200000" });
  const first = ledger.entries();
  assert.equal(first.length, 1);
  assert.throws(() => first.push({ fake: true }), TypeError);
  assert.throws(() => (first[0].feeMinor = "0"), TypeError);
  const second = ledger.entries();
  assert.equal(second.length, 1);
  assert.equal(second[0].feeMinor, "200000");
  assert.ok(second[0].seq < (ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t2", feeMinor: "1" }).seq));
});

test("applyCreditToPlacement rejects unknown trials and bad ids", () => {
  const { ledger } = makeLedger();
  assert.throws(
    () =>
      ledger.applyCreditToPlacement({
        clientId: "c1",
        placementId: "p1",
        trialTaskId: "ghost",
        creditMinor: "1",
      }),
    /unknown trial/i,
  );
  assert.throws(
    () => ledger.recordTrialFee({ clientId: "", trialTaskId: "t1", feeMinor: "1" }),
    /clientId/,
  );
  assert.throws(
    () => ledger.recordTrialFee({ clientId: "c1", trialTaskId: "t1", feeMinor: "1.5" }),
    /feeMinor/,
  );
  assert.throws(() => createFeeCreditLedger({ now: "nope" }), /now/);
});
