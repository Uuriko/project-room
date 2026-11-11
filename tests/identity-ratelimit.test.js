// B016: per-identity rate limits. Pure limiter tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, RateLimitError } from "../server/identity-ratelimit.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RateLimitError && error.code === code);

test("allows up to capacity, then refuses with friendly message", () => {
  const t = 0;
  const limiter = createRateLimiter({ now: () => t, capacity: 2, refillPerSecond: 1 });
  assert.equal(limiter.check("ada").allowed, true);
  assert.equal(limiter.check("ada").allowed, true);
  const refused = limiter.check("ada");
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterMs > 0);
  assert.ok(refused.message.includes("Please wait"));
  assert.ok(Object.isFrozen(refused));
  // Different identity has its own bucket.
  assert.equal(limiter.check("bob").allowed, true);
});
test("tokens refill over time", () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t, capacity: 1, refillPerSecond: 1 });
  assert.equal(limiter.check("ada").allowed, true);
  assert.equal(limiter.check("ada").allowed, false);
  t += 1500; // 1.5 seconds later
  assert.equal(limiter.check("ada").allowed, true);
});
test("malformed inputs are refused", () => {
  const limiter = createRateLimiter();
  throwsCode(() => limiter.check(""), "invalid_ratelimit");
  throwsCode(() => createRateLimiter({ capacity: 0 }), "invalid_ratelimit");
});

// Drafted by the existing Codex2 contributor (lobby334); Root adapted state() object access.
test('isolated keys and fractional refill distinguish retry from full reset', () => {
  let ms = 0;
  const limiter = createRateLimiter({
    capacity: 3, refillPerSecond: 1, now: () => ms
  });
  function check(key, allowed, remaining, retryAfterMs, resetAfterMs) {
    const d = limiter.check(key);
    assert.ok(Object.isFrozen(d));
    assert.equal(d.allowed, allowed);
    assert.equal(d.remaining, remaining);
    assert.equal(d.retryAfterMs, retryAfterMs);
    assert.equal(d.resetAfterMs, resetAfterMs);
    assert.ok(Object.hasOwn(d, 'message'));
  }
  check('keyA', true, 2, 0, 1000);
  check('keyA', true, 1, 0, 2000);
  check('keyA', true, 0, 0, 3000);
  check('keyB', true, 2, 0, 1000);
  assert.equal(limiter.state('keyA').tokens, 0);
  assert.equal(limiter.state('keyB').tokens, 2);
  check('keyA', false, 0, 1000, 3000);
  ms = 250;
  check('keyA', false, 0, 750, 2750);
  ms = 1250;
  // 1.25 tokens refill; spending one preserves the 0.25 remainder.
  check('keyA', true, 0, 0, 2750);
  check('keyA', false, 0, 750, 2750);
  ms = 2000;
  // The preserved quarter plus 0.75 refill permits another spend.
  check('keyA', true, 0, 0, 3000);
});
