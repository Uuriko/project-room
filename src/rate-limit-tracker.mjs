/**
 * rate-limit-tracker.mjs — Pure per-agent token-bucket rate limiter.
 *
 * Each agent+action pair owns a token bucket: `configure` sets the policy
 * {capacity, refillPerSec, burst?}; every consume removes tokens and the
 * bucket refills continuously at refillPerSec tokens/second (fractional),
 * driven by the injected clock. Buckets are fully isolated per agent and per
 * action, and an unconfigured pair falls back to the injected default policy.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure limiter. Time comes only from the injected clock, so tests can
 * use a fake clock for deterministic refill behavior.
 *
 * Dependency injection (all via the `deps` parameter of createRateLimitTracker):
 *   - clock:          () => number  (ms epoch; default: Date.now)
 *   - defaultPolicy:  {capacity, refillPerSec, burst?}
 *                     (fallback for unconfigured agent+action pairs;
 *                      default: { capacity: 60, refillPerSec: 1 })
 *
 * Policy semantics:
 *   - capacity:      sustained bucket size in tokens (> 0)
 *   - refillPerSec:  refill rate, tokens per second (>= 0; fractional allowed)
 *   - burst:         extra headroom above capacity (>= 0, default 0);
 *                    the bucket never holds more than capacity + burst tokens
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   RL_INVALID_POLICY — policy shape/values invalid (configure)
 *   RL_INVALID_TOKENS — tokens is not a finite number > 0 (tryConsume/consumeOrThrow)
 *   RL_INVALID_KEY    — agentId or action is not a non-empty string
 *   RL_RATE_LIMITED   — thrown only by consumeOrThrow on a denied consume;
 *                       detail carries { agentId, action, tokens, retryAfterMs }
 * Normal limiting NEVER throws: tryConsume returns { allowed, remaining,
 * retryAfterMs }, with allowed:false and a computed retryAfterMs when the
 * bucket is empty. Denials are appended to the audit log; successful consumes
 * are not (the limiter does not track granted history, only denials).
 */

const BUILT_IN_DEFAULT_POLICY = Object.freeze({ capacity: 60, refillPerSec: 1, burst: 0 });

/** Throw a coded limiter error (failures are never silent). */
function rlError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Round away floating-point dust so remaining/retry values stay exact. */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function isPolicyLike(p) {
  return p !== null && typeof p === 'object' && !Array.isArray(p);
}

/** Validate a policy; return a normalized copy. Throws RL_INVALID_POLICY. */
function normalizePolicy(policy, what) {
  if (!isPolicyLike(policy)) {
    throw rlError(
      'RL_INVALID_POLICY',
      `${what} must be an object { capacity, refillPerSec, burst? }`,
      { policy },
    );
  }
  const { capacity, refillPerSec, burst = 0 } = policy;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw rlError('RL_INVALID_POLICY', `${what}.capacity must be a finite number > 0`, {
      policy,
    });
  }
  if (!Number.isFinite(refillPerSec) || refillPerSec < 0) {
    throw rlError('RL_INVALID_POLICY', `${what}.refillPerSec must be a finite number >= 0`, {
      policy,
    });
  }
  if (!Number.isFinite(burst) || burst < 0) {
    throw rlError('RL_INVALID_POLICY', `${what}.burst must be a finite number >= 0`, {
      policy,
    });
  }
  return Object.freeze({ capacity, refillPerSec, burst, maxTokens: capacity + burst });
}

function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw rlError('RL_INVALID_KEY', 'agentId must be a non-empty string', { agentId });
  }
}

function assertAction(action) {
  if (typeof action !== 'string' || action.length === 0) {
    throw rlError('RL_INVALID_KEY', 'action must be a non-empty string', { action });
  }
}

function assertKey(agentId, action) {
  assertAgentId(agentId);
  assertAction(action);
}

function assertTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw rlError('RL_INVALID_TOKENS', 'tokens must be a finite number > 0', { tokens });
  }
}

/**
 * Create a per-agent token-bucket rate limiter.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {object} [deps.defaultPolicy]
 */
export function createRateLimitTracker(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const defaultPolicy = Object.freeze(
    deps.defaultPolicy === undefined
      ? { ...BUILT_IN_DEFAULT_POLICY }
      : normalizePolicy(deps.defaultPolicy, 'defaultPolicy'),
  );

  /** Buckets keyed by `${agentId}${action}`; value: { policy, tokens, lastRefill }. */
  const buckets = new Map();
  /** Append-only audit log of denials: every denied consume lands here. */
  const audit = [];

  function bucketKey(agentId, action) {
    return `${agentId}\u0000${action}`;
  }

  /** Create a fresh full bucket for a policy (or reuse the existing one). */
  function getOrCreateBucket(agentId, action, policy) {
    const key = bucketKey(agentId, action);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { policy: policy ?? defaultPolicy, tokens: 0, lastRefill: clock() };
      bucket.tokens = bucket.policy.maxTokens;
      buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Apply elapsed-time refill to a bucket (fractional; never above the max). */
  function refill(bucket) {
    const now = clock();
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    if (elapsedSec > 0 && bucket.policy.refillPerSec > 0) {
      bucket.tokens = Math.min(
        bucket.policy.maxTokens,
        bucket.tokens + elapsedSec * bucket.policy.refillPerSec,
      );
    }
    bucket.lastRefill = now;
  }

  /** Ms until `tokens` tokens can be served (0 when ready now). */
  function retryAfterMs(bucket, tokens) {
    const deficit = tokens - bucket.tokens;
    if (deficit <= 0) return 0;
    if (bucket.policy.refillPerSec <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil((deficit / bucket.policy.refillPerSec) * 1000);
  }

  function snapshot(bucket) {
    return Object.freeze({
      remaining: round6(bucket.tokens),
      capacity: bucket.policy.capacity,
      retryAfterMs: retryAfterMs(bucket, 1),
    });
  }

  const tracker = {
    /** Append-only audit trail of denials: {at, agentId, action, tokens, retryAfterMs}. */
    get audit() {
      return [...audit];
    },

    get defaultPolicy() {
      return defaultPolicy;
    },

    /**
     * Set (or replace) the policy for one agent+action pair. Replacing the
     * policy refills the bucket to the new maximum — a policy change is a
     * fresh grant.
     */
    configure(agentId, action, policy) {
      assertKey(agentId, action);
      const normalized = normalizePolicy(policy, 'policy');
      const key = bucketKey(agentId, action);
      const bucket = { policy: normalized, tokens: normalized.maxTokens, lastRefill: clock() };
      buckets.set(key, bucket);
      return snapshot(bucket);
    },

    /**
     * Try to consume `tokens` from the bucket. Never throws for normal
     * limiting: returns { allowed, remaining, retryAfterMs }. Denials are
     * recorded in the audit log.
     */
    tryConsume(agentId, action, { tokens = 1 } = {}) {
      assertKey(agentId, action);
      assertTokens(tokens);
      const bucket = getOrCreateBucket(agentId, action);
      refill(bucket);
      if (bucket.tokens >= tokens) {
        bucket.tokens -= tokens;
        return Object.freeze({
          allowed: true,
          remaining: round6(bucket.tokens),
          retryAfterMs: 0,
        });
      }
      const waitMs = retryAfterMs(bucket, tokens);
      audit.push(
        Object.freeze({
          at: clock(),
          agentId,
          action,
          tokens,
          remaining: round6(bucket.tokens),
          retryAfterMs: waitMs,
        }),
      );
      return Object.freeze({
        allowed: false,
        remaining: round6(bucket.tokens),
        retryAfterMs: waitMs,
      });
    },

    /**
     * Consume one token (or `tokens`) or throw RL_RATE_LIMITED with
     * detail.retryAfterMs. The ONLY operation that throws for limiting.
     */
    consumeOrThrow(agentId, action, { tokens = 1 } = {}) {
      const result = this.tryConsume(agentId, action, { tokens });
      if (!result.allowed) {
        throw rlError(
          'RL_RATE_LIMITED',
          `Rate limit exceeded for ${agentId}:${action}; retry in ${result.retryAfterMs}ms`,
          { agentId, action, tokens, retryAfterMs: result.retryAfterMs },
        );
      }
      return result;
    },

    /**
     * Reset buckets to full (keeping their configured policies). With `action`:
     * refill that agent+action bucket. Without: refill every bucket for the
     * agent. Unconfigured pairs keep the default policy.
     */
    reset(agentId, action) {
      if (action === undefined) {
        assertAgentId(agentId);
        const prefix = `${agentId}\u0000`;
        for (const [key, bucket] of buckets) {
          if (key.startsWith(prefix)) {
            bucket.tokens = bucket.policy.maxTokens;
            bucket.lastRefill = clock();
          }
        }
        return;
      }
      assertKey(agentId, action);
      const bucket = buckets.get(bucketKey(agentId, action));
      if (bucket) {
        bucket.tokens = bucket.policy.maxTokens;
        bucket.lastRefill = clock();
      }
    },

    /** Read-only snapshot for one agent+action pair (applies pending refill). */
    status(agentId, action) {
      assertKey(agentId, action);
      const bucket = getOrCreateBucket(agentId, action);
      refill(bucket);
      return snapshot(bucket);
    },
  };

  return Object.freeze(tracker);
}
