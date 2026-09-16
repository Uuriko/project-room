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
