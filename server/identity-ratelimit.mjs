// Per-identity rate limits (B016). A pure per-identity rate limiter: each
// identity gets a token bucket (capacity + refill rate); check() consumes
// a token or refuses with a friendly backoff message saying when to retry.
// All state is caller-owned (a Map); the module is pure and
// dependency-free (time is injected). Frozen outputs; malformed inputs
// throw RateLimitError. HTTP middleware wiring is a later slice.
class RateLimitError extends Error { constructor(code, message) { super(message); this.name = "RateLimitError"; this.code = code; } }
const fail = (code, message) => { throw new RateLimitError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_ratelimit", message); };
// Create a rate limiter. now is an injectable clock (ms).
export function createRateLimiter({ store, now, capacity = 60, refillPerSecond = 1 } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(now === undefined || typeof now === "function", "now must be a function if given");
  check(Number.isInteger(capacity) && capacity > 0, "capacity must be positive");
  check(Number.isFinite(refillPerSecond) && refillPerSecond > 0, "refillPerSecond must be positive");
  const clock = now ?? (() => Date.now());
  const buckets = store ?? new Map();
  const bucketFor = identityId => {
    check(typeof identityId === "string" && identityId.length > 0, "identityId must be a non-empty string");
    if (!buckets.has(identityId)) {
      buckets.set(identityId, { tokens: capacity, lastRefill: clock() });
    }
    return buckets.get(identityId);
  };
  // Refill based on elapsed time.
  const refill = bucket => {
    const elapsed = (clock() - bucket.lastRefill) / 1000;
    if (elapsed > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
      bucket.lastRefill = clock();
    }
  };
  // Check if an action is allowed. Returns { allowed, retryAfterMs, message }.
  const checkLimit = identityId => {
    const bucket = bucketFor(identityId);
    refill(bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(identityId, bucket);
      return Object.freeze({ allowed: true, retryAfterMs: 0,
        message: "OK" });
    }
    const retryAfterMs = Math.ceil((1 - bucket.tokens) / refillPerSecond * 1000);
    const seconds = Math.ceil(retryAfterMs / 1000);
    return Object.freeze({ allowed: false, retryAfterMs,
      message: `Rate limit reached. Please wait ${seconds} second${seconds === 1 ? "" : "s"} and try again.` });
  };
  // Get current bucket state (for dashboards).
  const state = identityId => {
    const bucket = bucketFor(identityId);
    refill(bucket);
    return Object.freeze({ identityId, tokens: Math.floor(bucket.tokens), capacity });
  };
  return Object.freeze({ check: checkLimit, state, capacity, refillPerSecond });
}
export { RateLimitError };
