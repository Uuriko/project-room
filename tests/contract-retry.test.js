/**
 * contract-retry.test.js — tests for the retry planner/executor.
 *
 * Covers: success first try, retry-then-success, non-retryable immediate
 * throw, exhaustion with attempts detail, jitter bounds, exponential growth,
 * maxDelayMs cap, budget exceeded, plan() pure schedule, the onAttempt hook,
 * and the coded-error contract. No real sleeping: fake clock/sleeper/random.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryPlanner } from '../src/contract-retry.mjs';

/** Controllable clock: { box, clock(), advance(ms) }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/**
 * Fake sleeper: records requested sleeps and advances the fake clock, so no
 * real time passes.
 */
function fakeSleeper(clock) {
  const sleeps = [];
  return {
    sleeps,
    sleeper: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  };
}

/** Fake random: cycles through the given sequence, then repeats the last value. */
function fakeRandom(sequence) {
  let i = 0;
  return () => {
    const value = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return value;
  };
}

/** Build a planner with fully controlled deps. */
function testPlanner({ randomSeq = [0], clockStart = 1_000_000 } = {}) {
  const clock = fakeClock(clockStart);
  const sleep = fakeSleeper(clock);
  const planner = createRetryPlanner({
    clock: clock.clock,
    id: (() => {
      let n = 0;
      return () => `run-${(n += 1)}`;
    })(),
    sleeper: sleep.sleeper,
    random: fakeRandom(randomSeq),
  });
  return { planner, clock, sleep };
}

const BASE_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  jitterRatio: 0,
  retryable: () => true,
};

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function expectRetryError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('contract-retry', () => {
  it('success first try: fn called once, no sleeping, value returned', async () => {
    const { planner, sleep } = testPlanner();
    let calls = 0;
    const result = await planner.run(
      () => {
        calls += 1;
        return 'ok';
      },
      BASE_POLICY,
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleep.sleeps, []);
    assert.equal(result.value, 'ok');
    assert.equal(result.runId, 'run-1');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].attempt, 1);
    assert.equal(result.attempts[0].error, null);
  });

  it('retry then success: fails twice, succeeds on third attempt', async () => {
    const { planner, sleep } = testPlanner();
    let calls = 0;
    const result = await planner.run(
      () => {
        calls += 1;
        if (calls < 3) throw errWithCode('boom', 'E_FLAKY');
        return 'recovered';
      },
      BASE_POLICY,
    );
    assert.equal(calls, 3);
    assert.equal(result.value, 'recovered');
    assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[2].error, null);
    // Exponential growth with jitterRatio 0: 100, then 200.
    assert.deepEqual(sleep.sleeps, [100, 200]);
  });

  it('non-retryable error throws immediately without sleeping', async () => {
    const { planner, sleep } = testPlanner();
    const fatal = errWithCode('fatal', 'E_FATAL');
    let calls = 0;
    const failing = (async () =>
      planner.run(
        () => {
          calls += 1;
          throw fatal;
        },
        { ...BASE_POLICY, retryable: (err) => err.code !== 'E_FATAL' },
      ))();
    await assert.rejects(failing, (err) => {
      assert.equal(err.code, 'CR_NON_RETRYABLE');
      assert.equal(err.cause, fatal, 'original error preserved on cause');
      assert.equal(err.attempts.length, 1);
      assert.equal(err.attempts[0].error, fatal);
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(sleep.sleeps, []);
  });

  it('exhausted: throws CR_EXHAUSTED with full attempts detail, never silent', async () => {
    const { planner, sleep } = testPlanner();
    let calls = 0;
    const failing = (async () =>
      planner.run(
        () => {
          calls += 1;
          throw errWithCode(`fail-${calls}`, 'E_FLAKY');
        },
        BASE_POLICY,
      ))();
    await assert.rejects(failing, (err) => {
      assert.equal(err.code, 'CR_EXHAUSTED');
      assert.ok(Array.isArray(err.attempts));
      assert.equal(err.attempts.length, 3);
      err.attempts.forEach((record, i) => {
        assert.equal(record.attempt, i + 1);
        assert.ok(record.error instanceof Error);
        assert.equal(record.error.message, `fail-${i + 1}`);
      });
      assert.deepEqual(
        err.attempts.map((r) => r.delayMs),
        [100, 200, null],
      );
      return true;
    });
    assert.equal(calls, 3);
    assert.deepEqual(sleep.sleeps, [100, 200]);
  });

  it('jitter bounds: actual delay lands within [d*(1-j), d]', async () => {
    // random = 1 -> minimum (d*(1-j)); random = 0 -> maximum (d).
    const jitter = 0.5;
    const { planner: pMin, sleep: sMin } = testPlanner({ randomSeq: [1, 1] });
    await assert.rejects(
      pMin.run(
        () => {
          throw new Error('x');
        },
        { ...BASE_POLICY, maxAttempts: 3, jitterRatio: jitter },
      ),
      { code: 'CR_EXHAUSTED' },
    );
    assert.deepEqual(sMin.sleeps, [50, 100]);

    const { planner: pMax, sleep: sMax } = testPlanner({ randomSeq: [0, 0] });
    await assert.rejects(
      pMax.run(
        () => {
          throw new Error('x');
        },
        { ...BASE_POLICY, maxAttempts: 3, jitterRatio: jitter },
      ),
      { code: 'CR_EXHAUSTED' },
    );
    assert.deepEqual(sMax.sleeps, [100, 200]);
  });

  it('exponential growth: delays double per attempt', async () => {
    const { planner, sleep } = testPlanner({ randomSeq: [0, 0, 0, 0] });
    await expectRetryError(
      planner.run(
        () => {
          throw new Error('always');
        },
        { ...BASE_POLICY, maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 1_000_000 },
      ),
      'CR_EXHAUSTED',
    );
    assert.deepEqual(sleep.sleeps, [50, 100, 200, 400]);
  });

  it('maxDelayMs cap: delays never exceed the cap', async () => {
    const { planner, sleep } = testPlanner({ randomSeq: [0, 0, 0, 0] });
    await expectRetryError(
      planner.run(
        () => {
          throw new Error('always');
        },
        { ...BASE_POLICY, maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250 },
      ),
      'CR_EXHAUSTED',
    );
    assert.deepEqual(sleep.sleeps, [100, 200, 250, 250]);
  });

  it('budget exceeded: CR_BUDGET_EXCEEDED with attempts so far', async () => {
    const { planner, clock } = testPlanner({ randomSeq: [0, 0, 0] });
    let calls = 0;
    const failing = (async () =>
      planner.run(
        () => {
          calls += 1;
          throw new Error('flaky');
        },
        { ...BASE_POLICY, maxAttempts: 10, baseDelayMs: 100, maxElapsedMs: 250 },
      ))();
    await assert.rejects(failing, (err) => {
      assert.equal(err.code, 'CR_BUDGET_EXCEEDED');
      assert.ok(Array.isArray(err.attempts));
      assert.equal(err.attempts.length, 2);
      assert.equal(err.detail.budgetMs, 250);
      assert.ok(err.detail.elapsedMs > 250);
      return true;
    });
    assert.equal(calls, 2);
    // Sleeps 100 then 200 -> clock at 300 > budget 250, so attempt 3 never starts.
    assert.equal(clock.box.now, 1_000_300);
  });

  it('plan(): pure delay schedule without executing', () => {
    const { planner, sleep } = testPlanner({ randomSeq: [0, 0, 0] });
    const schedule = planner.plan({
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 250,
      jitterRatio: 0,
    });
    assert.deepEqual(schedule, [100, 200, 250]);
    assert.deepEqual(sleep.sleeps, [], 'plan() must not sleep');
    assert.equal(schedule.length, 4 - 1);
  });

  it('plan() matches run() delays for the same random draws', async () => {
    const mk = () => testPlanner({ randomSeq: [0.25, 0.75] });
    const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0.5 };
    const { planner: p1 } = mk();
    const expected = p1.plan(policy);

    const { planner: p2, sleep } = mk();
    await expectRetryError(
      p2.run(() => {
        throw new Error('always');
      }, policy),
      'CR_EXHAUSTED',
    );
    assert.deepEqual(sleep.sleeps, expected);
  });

  it('onAttempt hook sees every attempt with runId', async () => {
    const { planner } = testPlanner({ randomSeq: [0, 0] });
    const seen = [];
    let calls = 0;
    const result = await planner.run(
      () => {
        calls += 1;
        if (calls < 2) throw new Error('flaky');
        return 'done';
      },
      BASE_POLICY,
      { onAttempt: (info) => seen.push(info) },
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[0].runId, result.runId);
    assert.equal(seen[0].attempt, 1);
    assert.equal(seen[0].ok, false);
    assert.ok(seen[0].error instanceof Error);
    assert.equal(seen[0].delayMs, 100);
    assert.equal(seen[1].ok, true);
    assert.equal(seen[1].error, null);
  });

  it('synchronous throw from fn is retried like an async rejection', async () => {
    const { planner, sleep } = testPlanner({ randomSeq: [0] });
    let calls = 0;
    const result = await planner.run(() => {
      calls += 1;
      if (calls === 1) throw new Error('sync boom');
      return 'async ok';
    }, BASE_POLICY);
    assert.equal(calls, 2);
    assert.deepEqual(sleep.sleeps, [100]);
    assert.equal(result.value, 'async ok');
  });

  it('coded-error contract: invalid policies throw CR_INVALID_POLICY', async () => {
    const { planner } = testPlanner();
    const bad = [
      { ...BASE_POLICY, maxAttempts: 0 },
      { ...BASE_POLICY, maxAttempts: 2.5 },
      { ...BASE_POLICY, baseDelayMs: -1 },
      { ...BASE_POLICY, maxDelayMs: 50 }, // < baseDelayMs (100)
      { ...BASE_POLICY, jitterRatio: -0.1 },
      { ...BASE_POLICY, jitterRatio: 1.1 },
      { ...BASE_POLICY, retryable: 'yes' },
      { ...BASE_POLICY, maxElapsedMs: 0 },
      null,
      'policy',
    ];
    for (const policy of bad) {
      await expectRetryError(planner.run(() => 'x', policy), 'CR_INVALID_POLICY');
      assert.throws(() => planner.plan(policy), (err) => err.code === 'CR_INVALID_POLICY');
    }
  });

  it('non-function fn throws CR_INVALID_POLICY', async () => {
    const { planner } = testPlanner();
    await expectRetryError(planner.run('not-a-function', BASE_POLICY), 'CR_INVALID_POLICY');
  });

  it('maxAttempts 1: single attempt, empty plan schedule', async () => {
    const { planner, sleep } = testPlanner();
    await expectRetryError(
      planner.run(() => {
        throw new Error('once');
      }, { ...BASE_POLICY, maxAttempts: 1 }),
      'CR_EXHAUSTED',
    );
    assert.deepEqual(sleep.sleeps, []);
    assert.deepEqual(planner.plan({ ...BASE_POLICY, maxAttempts: 1 }), []);
  });
});
