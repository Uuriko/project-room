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
test("check reports remaining and peek snapshots without consuming (S-05 merged bucket surface)", () => {
  const t = 1000;
  const limiter = createRateLimiter({ now: () => t, capacity: 2, refillPerSecond: 1 });
  assert.deepEqual(limiter.peek("k"), { remaining: 2, retryAfterMs: 0, fullAtMs: null });
  assert.equal(limiter.check("k").remaining, 1);
  assert.deepEqual(limiter.peek("k"), { remaining: 1, retryAfterMs: 0, fullAtMs: 2000 });
  assert.equal(limiter.check("k").remaining, 0);
  const refused = limiter.check("k");
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  const empty = limiter.peek("k");
  assert.equal(empty.remaining, 0);
  assert.ok(empty.retryAfterMs > 0);
  assert.equal(empty.fullAtMs, 3000);
  assert.ok(Object.isFrozen(empty));
  throwsCode(() => limiter.peek(""), "invalid_ratelimit");
});
test("a backwards clock step does not rewind the bucket or double-grant tokens (S-05)", () => {
  let t = 10000;
  const limiter = createRateLimiter({ now: () => t, capacity: 10, refillPerSecond: 1 });
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.check("k").allowed, true);
  assert.equal(limiter.check("k").allowed, false);
  t = 0; // rewound clock grants nothing
  limiter.peek("k");
  t = 10000; // returning must not refill the rewound interval a second time
  assert.equal(limiter.check("k").allowed, false);
  t = 11000;
  assert.equal(limiter.check("k").allowed, true);
  assert.equal(limiter.check("k").allowed, false);
});
test("malformed inputs are refused", () => {
  const limiter = createRateLimiter();
  throwsCode(() => limiter.check(""), "invalid_ratelimit");
  throwsCode(() => createRateLimiter({ capacity: 0 }), "invalid_ratelimit");
});
