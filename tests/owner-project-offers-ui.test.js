// COVERAGE CREW lane5: unit tests for offerMinorUnits in
// src/owner-project-offers-ui.js — the decimal-to-minor-units parsing that
// sets published offer reward amounts.
// Authoring gate: this guards the amount contract consumed by payload()
// before an offer draft is saved — a parsing slip publishes the wrong cash
// amount (e.g. "0.5" USDC parsed as 5 instead of 500000). Existing coverage:
// none — tests/ has zero references to src/owner-project-offers-ui.js. The
// rest of the module (installOwnerProjectOffers) is DOM and client code;
// importing the module pulls in src/events.js, which imports cleanly under
// node, so no stubs are needed.
import test from "node:test";
import assert from "node:assert/strict";
import { offerMinorUnits } from "../src/owner-project-offers-ui.js";

test("offerMinorUnits: whole amounts scale by the decimals", () => {
  assert.equal(offerMinorUnits("10", 2), "1000");
  assert.equal(offerMinorUnits("10", 6), "10000000");
});

test("offerMinorUnits: fractions are right-padded to the decimals", () => {
  assert.equal(offerMinorUnits("0.5", 2), "50");
  assert.equal(offerMinorUnits("10.25", 2), "1025");
  assert.equal(offerMinorUnits("1.5", 6), "1500000");
  assert.equal(offerMinorUnits("0.05", 2), "5");
});

test("offerMinorUnits: rejects more fraction digits than the decimals allow", () => {
  assert.throws(() => offerMinorUnits("10.255", 2), /up to 2 decimal places/);
  assert.throws(() => offerMinorUnits("1.0000001", 6), /up to 6 decimal places/);
  assert.throws(() => offerMinorUnits("1.", 2), /up to 2 decimal places/);
  assert.throws(() => offerMinorUnits(".5", 2), /up to 2 decimal places/);
});

test("offerMinorUnits: rejects zero and non-positive input", () => {
  assert.throws(() => offerMinorUnits("0", 2), /positive amount within the offer limit/);
  assert.throws(() => offerMinorUnits("0.0", 2), /positive amount within the offer limit/);
  assert.throws(() => offerMinorUnits("0.00", 2), /positive amount within the offer limit/);
});

test("offerMinorUnits: rejects non-numeric and malformed amounts", () => {
  assert.throws(() => offerMinorUnits("", 2), /positive amount with up to/);
  assert.throws(() => offerMinorUnits("abc", 2), /positive amount with up to/);
  assert.throws(() => offerMinorUnits("-5", 2), /positive amount with up to/);
  assert.throws(() => offerMinorUnits("00.5", 2), /positive amount with up to/);
  assert.throws(() => offerMinorUnits("1,000", 2), /positive amount with up to/);
});

test("offerMinorUnits: enforces the 18-digit minor-units limit", () => {
  // 16 whole digits + 2 fraction digits = 18 minor units: allowed.
  assert.equal(offerMinorUnits("9999999999999999", 2), "999999999999999900");
  // One more whole digit pushes the minor-unit string past 18: rejected.
  assert.throws(() => offerMinorUnits("99999999999999999", 2), /within the offer limit/);
});
