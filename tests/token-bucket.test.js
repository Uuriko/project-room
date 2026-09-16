// H002: rate limiting. Pure token-bucket tests; no shared state beyond the caller's Map.
import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter, RateLimitError } from "../server/token-bucket.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RateLimitError && error.code === code);

test("burst is allowed, then refused with a Retry-After hint", () => {
  const limiter = createLimiter({ rate: 1, burst: 2 });
  const first = limiter.tryTake("agent:quill", { now: 1000 });
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  const second = limiter.tryTake("agent:quill", { now: 1000 });
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  const third = limiter.tryTake("agent:quill", { now: 1000 });
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterMs > 0);
  assert.ok(Object.isFrozen(third));
  // After one second the bucket refills one token.
  const refilled = limiter.tryTake("agent:quill", { now: 2000 });
  assert.equal(refilled.allowed, true);
});
test("keys are independent and reset clears a bucket", () => {
  const limiter = createLimiter({ rate: 1, burst: 1 });
  limiter.tryTake("a", { now: 0 });
  assert.equal(limiter.tryTake("a", { now: 0 }).allowed, false);
  assert.equal(limiter.tryTake("b", { now: 0 }).allowed, true);
  limiter.reset("a");
  assert.equal(limiter.tryTake("a", { now: 0 }).allowed, true);
});
test("malformed configs and calls are refused", () => {
  throwsCode(() => createLimiter({ rate: 0, burst: 1 }), "invalid_rate_limit");
  throwsCode(() => createLimiter({ rate: 1, burst: 1, store: {} }), "invalid_rate_limit");
  const limiter = createLimiter({ rate: 1, burst: 1 });
  throwsCode(() => limiter.tryTake("", { now: 0 }), "invalid_rate_limit");
  throwsCode(() => limiter.tryTake("a", { now: Number.NaN }), "invalid_rate_limit");
});
