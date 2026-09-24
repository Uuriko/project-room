// Rate limiting (H002). A pure token-bucket limiter: createLimiter({ rate,
// burst }) returns an object with tryTake(key, { now }) that refills each
// key's bucket at `rate` tokens per second up to `burst`, consumes one token
// per call, and refuses with a Retry-After hint when the bucket is empty.
// peek(key, { now }) snapshots a bucket without consuming. Bucket state lives in a caller-owned Map (pass your own to share across
// limiter instances); the limiter itself holds no shared state, so it is
// safe to construct per request. Time is injectable via { now } for tests.
// Pure, dependency-free, deterministic; frozen results. HTTP middleware
// wiring is a later slice.
class RateLimitError extends Error { constructor(code, message) { super(message); this.name = "RateLimitError"; this.code = code; } }
const fail = (code, message) => { throw new RateLimitError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_rate_limit", message); };

export function createLimiter({ rate, burst, store } = {}) {
  check(typeof rate === "number" && rate > 0 && rate <= 100000, "rate must be tokens/sec 0..100000");
  check(Number.isInteger(burst) && burst >= 1 && burst <= 100000, "burst must be an integer 1..100000");
  const buckets = store ?? new Map();
  check(buckets instanceof Map, "store must be a Map");
  const refill = (bucket, now) => {
    const elapsed = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
    bucket.updatedAt = now;
  };
  // Attempt one token for key. Returns { allowed, remaining, retryAfterMs }.
  const tryTake = (key, { now } = {}) => {
    check(typeof key === "string" && key.length > 0 && key.length <= 256, "key must be a non-empty string up to 256 chars");
    const at = now ?? Date.now();
    check(typeof at === "number" && Number.isFinite(at), "now must be a finite number");
    if (!buckets.has(key)) buckets.set(key, { tokens: burst, updatedAt: at });
    const bucket = buckets.get(key);
    refill(bucket, at);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return Object.freeze({ allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 });
    }
    const retryAfterMs = Math.ceil(((1 - bucket.tokens) / rate) * 1000);
    return Object.freeze({ allowed: false, remaining: 0, retryAfterMs });
  };
  // Non-consuming snapshot for diagnostics: { remaining, retryAfterMs,
  // fullAtMs }. fullAtMs is null when the bucket is already full, otherwise the
  // instant it returns to full at the current refill rate.
  const peek = (key, { now } = {}) => {
    check(typeof key === "string" && key.length > 0 && key.length <= 256, "key must be a non-empty string up to 256 chars");
    const at = now ?? Date.now();
    check(typeof at === "number" && Number.isFinite(at), "now must be a finite number");
    if (!buckets.has(key)) return Object.freeze({ remaining: burst, retryAfterMs: 0, fullAtMs: null });
    const bucket = buckets.get(key);
    refill(bucket, at);
    const remaining = Math.floor(bucket.tokens);
    const retryAfterMs = bucket.tokens >= 1 ? 0 : Math.ceil(((1 - bucket.tokens) / rate) * 1000);
    const fullAtMs = bucket.tokens >= burst ? null : Math.ceil(at + ((burst - bucket.tokens) / rate) * 1000);
    return Object.freeze({ remaining, retryAfterMs, fullAtMs });
  };
  const reset = key => {
    check(typeof key === "string" && key.length > 0, "key must be a non-empty string");
    buckets.delete(key);
  };
  return Object.freeze({ tryTake, peek, reset, rate, burst });
}
export { RateLimitError };
