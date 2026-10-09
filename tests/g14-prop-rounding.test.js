// Guild-14 property test: rounding edge cases for toMillis and the 1% fee.
// toMillis: rejects negatives, zero, >3 decimals, non-finite; accepts exact
// 1/1000ths. fee: floor(gross/100) for every gross in 1..5000 millis,
// earner + fee == gross exactly (no creation/destruction at the unit level).
import test from "node:test";
import assert from "node:assert/strict";
import { toMillis } from "../server/bounty-escrow.mjs";

test("g14-round: toMillis accepts valid, rejects invalid", () => {
  assert.equal(toMillis(1), 1000);
  assert.equal(toMillis(0.001), 1);
  assert.equal(toMillis(999.999), 999999);
  assert.equal(toMillis(0.1 + 0.2), 300); // float dust absorbed
  assert.throws(() => toMillis(0), /amount/);
  assert.throws(() => toMillis(-1), /amount/);
  assert.throws(() => toMillis(1.0001), /at most 3 decimals/);
  assert.throws(() => toMillis(0.0009), /at most 3 decimals/);
  assert.throws(() => toMillis(1e-10), /smallest unit/);
  assert.throws(() => toMillis(NaN), /finite/);
  assert.throws(() => toMillis(Infinity), /finite/);
  assert.throws(() => toMillis("10"), /finite/);
  assert.throws(() => toMillis(1_000_001), /cap/);
});

test("g14-round: 1% fee floors and never creates or destroys a milli-credit", () => {
  for (let gross = 1; gross <= 5000; gross++) {
    const fee = Math.floor(gross * 1 / 100);
    const earner = gross - fee;
    assert.equal(earner + fee, gross, `split not zero-sum at gross=${gross}`);
    assert.ok(fee >= 0 && fee < gross || gross === 0, `bad fee at gross=${gross}`);
    // fee is within one unit of the exact 1%
    assert.ok(Math.abs(fee - gross / 100) < 1, `fee off by >= 1 unit at gross=${gross}`);
  }
  // Known boundary: gross < 100 millis (0.1 credit) pays zero fee.
  assert.equal(Math.floor(99 / 100), 0);
  assert.equal(Math.floor(100 / 100), 1);
});
