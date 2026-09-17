/**
 * contract-retry.mjs — Pure retry planner/executor with exponential backoff and jitter.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret — it
 * is a pure retry machine. The retried work is an injected `fn` per call.
 *
 * Retry contract:
 *   - run(fn, policy, { onAttempt? }) attempts fn until success or the policy
 *     is exhausted. Success resolves to { value, attempts }.
 *   - Delay before attempt n+1 (n ≥ 1):
 *       delay = min(maxDelayMs, baseDelayMs * 2^(n-1))
 *     with proportional jitter:
 *       actual = delay * (1 - jitterRatio * random())
 *     so each actual delay lands in [delay * (1 - jitterRatio), delay].
 *   - A non-retryable error (policy.retryable(err) === false) throws
 *     immediately as CR_NON_RETRYABLE with the original error as `cause`.
 *   - Exhausting maxAttempts throws CR_EXHAUSTED with err.attempts[] —
 *     each { attempt, error, delayMs } — so a failure is never silent.
 *   - Budget: if clock() - start > maxElapsedMs before an attempt starts,
 *     throws CR_BUDGET_EXCEEDED with the attempts recorded so far.
 *   - plan(policy) returns the pure delay schedule [d1, d2, ...] — the
 *     jittered delays between attempts — without executing anything. It is
 *     for tests and docs. Note: plan() draws from the injected random()
 *     source, so calling plan() then run() on the same planner shifts run()'s
 *     draws; inject a seeded random for deterministic comparisons.
 *
 * Policy:
 *   - maxAttempts:  integer ≥ 1 (required)
 *   - baseDelayMs:  number ≥ 0 (required)
 *   - maxDelayMs:   number ≥ 0 and ≥ baseDelayMs (required)
 *   - jitterRatio:  number in [0, 1] (required; 0 = no jitter)
 *   - retryable:    (err) => boolean (optional; default: always retry)
 *   - maxElapsedMs: number > 0 (optional total wall-clock budget per run)
 *
 * Dependency injection (all via the `deps` parameter of createRetryPlanner):
 *   - clock:   () => number            (ms epoch; default: Date.now)
 *   - id:      () => string            (run id generator; default: per-planner counter)
 *   - sleeper: (ms: number) => Promise (default: setTimeout promise)
 *   - random:  () => number            (uniform [0, 1); default: Math.random)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   CR_INVALID_POLICY   — policy shape invalid (maxAttempts < 1, jitterRatio
 *                         out of range, maxDelayMs < baseDelayMs, ...)
 *   CR_NON_RETRYABLE    — fn threw an error the policy declines to retry;
 *                         original error on `cause`, attempts so far on `attempts`
 *   CR_EXHAUSTED        — all maxAttempts failed; detail on `attempts`
 *   CR_BUDGET_EXCEEDED  — elapsed wall clock passed maxElapsedMs before the
 *                         next attempt; attempts so far on `attempts`
 * Failures are never silent.
 */

const DEFAULT_RETRYABLE = () => true;

/** Throw a coded retry error (never silent failures). */
function retryError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  if (detail?.cause !== undefined) err.cause = detail.cause;
  if (detail?.attempts !== undefined) err.attempts = detail.attempts;
  return err;
}

function isNonNegativeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Validate a policy; throw CR_INVALID_POLICY on any shape problem. */
function validatePolicy(policy) {
  const problems = [];
  if (policy === null || typeof policy !== 'object') {
    throw retryError('CR_INVALID_POLICY', 'Policy must be an object', { policy });
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    problems.push('maxAttempts must be an integer ≥ 1');
  }
  if (!isNonNegativeNumber(policy.baseDelayMs)) {
    problems.push('baseDelayMs must be a finite number ≥ 0');
  }
  if (!isNonNegativeNumber(policy.maxDelayMs)) {
    problems.push('maxDelayMs must be a finite number ≥ 0');
  } else if (
    isNonNegativeNumber(policy.baseDelayMs) &&
    policy.maxDelayMs < policy.baseDelayMs
  ) {
    problems.push('maxDelayMs must be ≥ baseDelayMs');
  }
  if (
    typeof policy.jitterRatio !== 'number' ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    problems.push('jitterRatio must be a number in [0, 1]');
  }
  if (policy.retryable !== undefined && typeof policy.retryable !== 'function') {
    problems.push('retryable must be a function (err) => boolean');
  }
  if (
    policy.maxElapsedMs !== undefined &&
    !(typeof policy.maxElapsedMs === 'number' &&
      Number.isFinite(policy.maxElapsedMs) &&
      policy.maxElapsedMs > 0)
  ) {
    problems.push('maxElapsedMs must be a finite number > 0 when present');
  }
  if (problems.length > 0) {
    throw retryError('CR_INVALID_POLICY', `Invalid retry policy: ${problems.join('; ')}`, {
      problems,
    });
  }
  return {
    maxAttempts: policy.maxAttempts,
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: policy.maxDelayMs,
    jitterRatio: policy.jitterRatio,
    retryable: policy.retryable ?? DEFAULT_RETRYABLE,
    maxElapsedMs: policy.maxElapsedMs ?? null,
  };
}

/** Unjittered exponential delay before attempt (n+1), capped at maxDelayMs. */
function baseDelayFor(policy, attempt) {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

/** Jittered delay: delay * (1 - jitterRatio * random()), i.e. in [d*(1-j), d]. */
function jitteredDelayFor(policy, attempt, random) {
  const delay = baseDelayFor(policy, attempt);
  return delay * (1 - policy.jitterRatio * random());
}

/**
 * Create a retry planner/executor with injected deps.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(ms: number) => Promise<void>} [deps.sleeper]
 * @param {() => number} [deps.random]
 */
export function createRetryPlanner(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const sleeper = deps.sleeper ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;

  let idCounter = 0;
  const newId = deps.id ?? (() => `retry-${(idCounter += 1)}`);

  /**
   * Pure delay schedule for a policy: the jittered waits [d1, d2, ...] between
   * attempts, without executing anything. Length is maxAttempts - 1.
   * @param {object} policy
   * @returns {number[]}
   */
  function plan(policy) {
    const p = validatePolicy(policy);
    const schedule = [];
    for (let attempt = 1; attempt < p.maxAttempts; attempt += 1) {
      schedule.push(jitteredDelayFor(p, attempt, random));
    }
    return schedule;
  }

  /**
   * Attempt fn until success or policy exhaustion.
   * @param {(ctx: { attempt: number, runId: string }) => any} fn
   * @param {object} policy
   * @param {object} [opts]
   * @param {(info: object) => void} [opts.onAttempt] called after every attempt
   * @returns {Promise<{ value: any, runId: string, attempts: Array }>}
   */
  async function run(fn, policy, opts = {}) {
    const p = validatePolicy(policy);
    if (typeof fn !== 'function') {
      throw retryError('CR_INVALID_POLICY', 'fn must be a function', { fn });
    }
    const onAttempt = opts.onAttempt ?? null;
    const runId = newId();
    const startedAt = clock();
    /** @type {Array<{ attempt: number, error: any, delayMs: number|null }>} */
    const attempts = [];

    function notify(info) {
      if (onAttempt) onAttempt(Object.freeze({ runId, ...info }));
    }

    for (let attempt = 1; attempt <= p.maxAttempts; attempt += 1) {
      const elapsedMs = clock() - startedAt;
      if (p.maxElapsedMs !== null && elapsedMs > p.maxElapsedMs) {
        notify({ attempt, ok: false, error: null, delayMs: null, elapsedMs, skipped: 'budget' });
        throw retryError(
          'CR_BUDGET_EXCEEDED',
          `Retry budget exceeded: ${elapsedMs}ms elapsed > maxElapsedMs ${p.maxElapsedMs}ms (run ${runId}, ${attempts.length} attempts)`,
          { runId, budgetMs: p.maxElapsedMs, elapsedMs, attempts: [...attempts] },
        );
      }

      let value;
      try {
        value = await fn({ attempt, runId });
      } catch (err) {
        const isRetryable = p.retryable(err);
        const delayMs =
          attempt < p.maxAttempts ? jitteredDelayFor(p, attempt, random) : null;
        attempts.push({ attempt, error: err, delayMs });
        notify({ attempt, ok: false, error: err, delayMs, elapsedMs: clock() - startedAt });

        if (!isRetryable) {
          throw retryError(
            'CR_NON_RETRYABLE',
            `Attempt ${attempt} failed with a non-retryable error (run ${runId})`,
            { runId, attempt, cause: err, attempts: [...attempts] },
          );
        }
        if (attempt >= p.maxAttempts) {
          throw retryError(
            'CR_EXHAUSTED',
            `Retry exhausted after ${p.maxAttempts} attempts (run ${runId})`,
            { runId, maxAttempts: p.maxAttempts, attempts: [...attempts] },
          );
        }
        await sleeper(delayMs);
        continue;
      }

      attempts.push({ attempt, error: null, delayMs: null });
      notify({ attempt, ok: true, error: null, delayMs: null, elapsedMs: clock() - startedAt });
      return { value, runId, attempts: [...attempts] };
    }

    // Unreachable: the loop either returns, or throws exhausted / budget.
    throw retryError('CR_EXHAUSTED', `Retry exhausted after ${p.maxAttempts} attempts (run ${runId})`, {
      runId,
      maxAttempts: p.maxAttempts,
      attempts: [...attempts],
    });
  }

  return Object.freeze({ plan, run });
}
