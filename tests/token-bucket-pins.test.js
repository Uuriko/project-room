// tests/token-bucket-pins.test.js — B1-1 PIN tests for server/token-bucket.mjs.
// Landed from the methods audit (wave-2026-10-26-methods-audit, phase-b/B1,
// B1-1): the audit's distinguishing tests for the 22 ACTIONABLE token-bucket
// mutants (11 findings F-TB1…F-TB11), unweakened. Each test passes on
// pristine server/token-bucket.mjs and fails on the named survived mutant(s).
// (B1-1's spend-pricing leg is NOT landed here: its real suite was
// BLOCKED-baseline in the audit and its distinguishing tests were proven
// against a stub harness, not the repo suite — named as remainder in the PR.)
import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, RateLimitError } from "../server/token-bucket.mjs";

test("D-config-rate-max TB02: rate=100000 is accepted", () => {
  const l = createLimiter({ rate: 100000, burst: 1 });
  assert.equal(l.tryTake("k", { now: 0 }).allowed, true);
});
test("D-config-burst-max TB05: burst=100000 is accepted", () => {
  assert.doesNotThrow(() => createLimiter({ rate: 1, burst: 100000 }));
});
test("D-config-burst-integer TB06: burst=1.5 is refused", () => {
  assert.throws(() => createLimiter({ rate: 1, burst: 1.5 }), e => e instanceof RateLimitError);
});
test("D-refill-guard-rewind TB09: rewind does not change state at intermediate times", () => {
  const l = createLimiter({ rate: 1, burst: 10 });
  for (let i = 0; i < 5; i++) l.tryTake("k", { now: 10000 });
  l.peek("k", { now: 0 }); // rewind step
  assert.equal(l.peek("k", { now: 0 }).remaining, 5);
  assert.equal(l.tryTake("k", { now: 5000 }).allowed, true);
});
test("D-refill-rate-scaling TB14: refill adds elapsed*rate tokens", () => {
  const l = createLimiter({ rate: 2, burst: 10 });
  for (let i = 0; i < 10; i++) l.tryTake("k", { now: 0 });
  assert.equal(l.tryTake("k", { now: 1000 }).allowed, true);
  assert.equal(l.tryTake("k", { now: 1000 }).allowed, true);
  assert.equal(l.tryTake("k", { now: 1000 }).allowed, false);
});
test("D-refill-cap TB15: refill never exceeds burst", () => {
  const l = createLimiter({ rate: 1, burst: 2 });
  l.tryTake("k", { now: 0 }); l.tryTake("k", { now: 0 });
  assert.equal(l.tryTake("k", { now: 100000 }).allowed, true);
  assert.equal(l.tryTake("k", { now: 100000 }).allowed, true);
  assert.equal(l.tryTake("k", { now: 100000 }).allowed, false);
});
test("D-key-256-tryTake TB17: a 256-char key is accepted by tryTake", () => {
  const l = createLimiter({ rate: 1, burst: 1 });
  assert.equal(l.tryTake("k".repeat(256), { now: 0 }).allowed, true);
});
test("D-key-256-peek TB41: a 256-char key is accepted by peek", () => {
  const l = createLimiter({ rate: 1, burst: 1 });
  assert.equal(l.peek("k".repeat(256), { now: 0 }).remaining, 1);
});
test("D-remaining-floor TB24: remaining floors fractional tokens", () => {
  const l = createLimiter({ rate: 1, burst: 3 });
  l.tryTake("k", { now: 0 });
  const r = l.tryTake("k", { now: 500 });
  assert.equal(r.remaining, 1);
});
test("D-retryAfter-allowed TB25: an allowed take reports retryAfterMs 0", () => {
  const l = createLimiter({ rate: 1, burst: 1 });
  assert.equal(l.tryTake("k", { now: 0 }).retryAfterMs, 0);
});
test("D-retryAfter-exact TB26/TB27/TB28: denied retryAfterMs is ceil((1-tokens)/rate*1000)", () => {
  const l = createLimiter({ rate: 3, burst: 1 });
  l.tryTake("k", { now: 0 });
  const denied = l.tryTake("k", { now: 0 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 334);
});
test("D-peek-unknown TB30/TB31: peek of an unknown key reports a full bucket", () => {
  const l = createLimiter({ rate: 2, burst: 4 });
  assert.deepEqual(l.peek("nope", { now: 0 }), { remaining: 4, retryAfterMs: 0, fullAtMs: null });
});
test("D-peek-remaining TB32: peek remaining floors fractional tokens", () => {
  const l = createLimiter({ rate: 1, burst: 3 });
  l.tryTake("k", { now: 0 });
  assert.equal(l.peek("k", { now: 500 }).remaining, 2);
});
test("D-peek-retry-stocked TB34: peek of a stocked bucket reports retryAfterMs 0", () => {
  const l = createLimiter({ rate: 1, burst: 2 });
  l.tryTake("k", { now: 0 }); // bucket now exists with 1 token
  assert.equal(l.peek("k", { now: 0 }).retryAfterMs, 0);
});
test("D-retryAfter-fractional TB27: denied retryAfterMs uses (1 - tokens), not (1 + tokens)", () => {
  const l = createLimiter({ rate: 3, burst: 2 });
  l.tryTake("k", { now: 0 }); l.tryTake("k", { now: 0 });
  const denied = l.tryTake("k", { now: 100 }); // refills to 0.3 tokens, still denied
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 234);
});
test("D-peek-retry-drained TB35: peek of a drained bucket reports exact retryAfterMs", () => {
  const l = createLimiter({ rate: 2, burst: 1 });
  l.tryTake("k", { now: 0 });
  assert.equal(l.peek("k", { now: 0 }).retryAfterMs, 500);
});
test("D-peek-fullAt-full TB36: peek of a full bucket reports fullAtMs null", () => {
  const l = createLimiter({ rate: 10, burst: 2 });
  l.tryTake("k", { now: 0 }); // bucket exists, 1 token left
  assert.equal(l.peek("k", { now: 10000 }).fullAtMs, null); // refilled to full
});
test("D-peek-fullAt-value TB37/TB38: fullAtMs is at + (burst-tokens)/rate*1000, ceiled", () => {
  const l = createLimiter({ rate: 2, burst: 3 });
  l.tryTake("k", { now: 1000 });
  assert.equal(l.peek("k", { now: 1000 }).fullAtMs, 1500);
});
test("D-reset-empty TB39: reset of an empty key is refused", () => {
  const l = createLimiter({ rate: 1, burst: 1 });
  assert.throws(() => l.reset(""), e => e instanceof RateLimitError);
});
