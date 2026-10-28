import test from "node:test";
import assert from "node:assert/strict";
import { createTestClock, freezeDate } from "./helpers/test-clock.mjs";

test("TST-11: createTestClock is fixed until advanced or set", () => {
  const clock = createTestClock(Date.UTC(2026, 0, 15, 12));
  const start = clock.now();
  assert.equal(clock.now(), start, "no drift between reads");
  assert.equal(clock.advance(1500), start + 1500);
  assert.equal(clock.now(), start + 1500);
  assert.equal(clock.iso(), "2026-01-15T12:00:01.500Z");
  assert.equal(clock.iso(60_000), "2026-01-15T12:01:01.500Z");
  assert.equal(clock.set(Date.UTC(2027, 0, 1)), Date.UTC(2027, 0, 1));
});

test("TST-11: createTestClock refuses bad input", () => {
  assert.throws(() => createTestClock(Number.NaN), TypeError);
  const clock = createTestClock(0);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => clock.set("soon"), TypeError);
});

test("TST-11: freezeDate pins Date for one test and leaves real timers alone", async t => {
  const at = Date.UTC(2026, 5, 1);
  const frozen = freezeDate(t, at);
  assert.equal(Date.now(), at);
  assert.equal(new Date().toISOString(), "2026-06-01T00:00:00.000Z");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(Date.now(), at, "a real wait does not move the frozen clock");
  assert.equal(frozen.advance(5000), at + 5000);
  assert.equal(Date.now(), at + 5000);
});

test("TST-11: freezeDate is undone after the test", () => {
  assert.ok(Date.now() > Date.UTC(2026, 5, 2), "global Date is real again");
});
