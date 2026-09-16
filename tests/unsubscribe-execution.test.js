/**
 * unsubscribe-execution.test.js — tests for per-message unsubscribe detection
 * + execution planning.
 *
 * Covers: one-click detection, mailto-only, http-only, both (https preferred),
 * angle-bracket parsing, garbage header → null, execute happy path, unconfirmed
 * rejection, retry-once on transient failure, batch detection, skip path, and
 * the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUnsubscribeEngine,
  detectUnsubscribe,
  METHODS,
  STATES,
  CONFIDENCE,
} from '../src/unsubscribe-execution.mjs';

/** Controllable clock: { clock(), advance(ms) }. */
function fakeClock(start = 2_000_000) {
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
 * Injected executor fake.
 * @param {Array<Error | 'transient-once' | 'transient-forever' | 'ok'>} plan
 *   per-call behavior: 'ok' resolves, 'transient-once' throws transient on the
 *   first call then resolves, 'transient-forever' always throws transient,
 *   an Error instance always throws that error (non-transient unless marked).
 */
function fakeExecutor(plan = []) {
  const calls = [];
  let n = 0;
  const exec = async (detection) => {
    calls.push(detection);
    n += 1;
    const step = plan[Math.min(n - 1, plan.length - 1)] ?? 'ok';
    if (step === 'ok') return { status: 200, delivered: true };
    if (step === 'transient-once') {
      if (n === 1) {
        const err = new Error('temporary network blip');
        err.transient = true;
        throw err;
      }
      return { status: 200, delivered: true };
    }
    if (step === 'transient-forever') {
      const err = new Error('service unavailable');
      err.code = 'UD_EXEC_TRANSIENT';
      throw err;
    }
    throw step; // caller-supplied Error
  };
  exec.calls = calls;
  return exec;
}

function expectUdErrorSync(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

async function expectUdErrorAsync(promiseFn, code) {
  await assert.rejects(promiseFn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('unsubscribe-execution detection', () => {
  it('one-click: List-Unsubscribe-Post + https URL → one-click, confidence 1.0', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Unsubscribe': '<https://example.com/unsub/abc123>',
    });
    assert.ok(found);
    assert.equal(found.method, 'one-click');
    assert.equal(found.target, 'https://example.com/unsub/abc123');
    assert.equal(found.confidence, CONFIDENCE['one-click']);
    assert.equal(found.confidence, 1.0);
  });

  it('one-click post header is matched case-insensitively', () => {
    const found = detectUnsubscribe({
      'list-unsubscribe-post': 'list-unsubscribe=one-click',
      'list-unsubscribe': '<https://example.com/unsub>',
    });
    assert.equal(found.method, 'one-click');
  });

  it('mailto-only header → mailto', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe': '<mailto:unsubscribe@example.com?subject=unsubscribe>',
    });
    assert.ok(found);
    assert.equal(found.method, 'mailto');
    assert.equal(found.target, 'mailto:unsubscribe@example.com?subject=unsubscribe');
    assert.equal(found.confidence, CONFIDENCE.mailto);
  });

  it('http-only header → http', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe': '<https://example.com/opt-out>',
    });
    assert.equal(found.method, 'http');
    assert.equal(found.target, 'https://example.com/opt-out');
  });

  it('both mailto and https → https preferred (first https wins)', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe':
        '<mailto:unsub@example.com?subject=stop>, <https://example.com/u/1>, <https://example.com/u/2>',
    });
    assert.equal(found.method, 'http');
    assert.equal(found.target, 'https://example.com/u/1');
  });

  it('plain http fallback when no https present', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe': '<http://example.com/unsub>, <mailto:x@y.z>',
    });
    assert.equal(found.method, 'http');
    assert.equal(found.target, 'http://example.com/unsub');
  });

  it('parses multiple headers and ignores whitespace around entries', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe': [
        '<mailto:a@example.com> ,',
        ' <https://example.com/second>',
      ],
    });
    assert.equal(found.method, 'http');
    assert.equal(found.target, 'https://example.com/second');
  });

  it('garbage header → null', () => {
    assert.equal(detectUnsubscribe({ 'List-Unsubscribe': 'definitely not a url' }), null);
  });

  it('missing headers → null', () => {
    assert.equal(detectUnsubscribe({}), null);
    assert.equal(detectUnsubscribe(null), null);
  });

  it('one-click signal without a usable https URL falls back to mailto', () => {
    const found = detectUnsubscribe({
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Unsubscribe': '<mailto:stop@example.com>',
    });
    assert.equal(found.method, 'mailto');
  });

  it('one-click signal with no usable targets at all → null', () => {
    assert.equal(
      detectUnsubscribe({
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'List-Unsubscribe': 'no urls here',
      }),
      null,
    );
  });

  it('exposes METHODS and STATES', () => {
    assert.deepEqual([...METHODS], ['one-click', 'http', 'mailto']);
    assert.ok(STATES.includes('detected'));
    assert.ok(STATES.includes('executing'));
    assert.ok(STATES.includes('done'));
    assert.ok(STATES.includes('failed'));
    assert.ok(STATES.includes('skipped'));
  });
});

describe('unsubscribe-execution engine', () => {
  it('execute happy path: detected → executing → done, executor called once', async () => {
    const { clock } = fakeClock();
    const exec = fakeExecutor();
    const engine = createUnsubscribeEngine({ clock, executor: exec });

    const detection = engine.detect({
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Unsubscribe': '<https://example.com/unsub/x>',
    });
    assert.ok(detection);
    assert.equal(detection.state, 'detected');
    assert.equal(detection.method, 'one-click');

    const done = await engine.execute(detection.id, { confirmed: true });
    assert.equal(done.state, 'done');
    assert.equal(done.attempts.length, 1);
    assert.ok(done.attempts[0].ok);

    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].method, 'one-click');
    assert.equal(exec.calls[0].target, 'https://example.com/unsub/x');
    assert.equal(exec.calls[0].id, detection.id);

    const trail = engine.audit.filter((e) => e.detectionId === detection.id);
    assert.ok(trail.some((e) => e.to === 'detected'));
    assert.ok(trail.some((e) => e.to === 'executing'));
    assert.ok(trail.some((e) => e.to === 'done'));
    assert.ok(trail.some((e) => e.attempt === 1));
  });

  it('execute accepts a detection record object as well as an id', async () => {
    const exec = fakeExecutor();
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<mailto:bye@example.com>',
    });
    const done = await engine.execute(detection, { confirmed: true });
    assert.equal(done.state, 'done');
    assert.equal(exec.calls[0].method, 'mailto');
  });

  it('unconfirmed execute rejected with UD_NOT_CONFIRMED; executor never called', async () => {
    const exec = fakeExecutor();
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<https://example.com/u>',
    });

    await expectUdErrorAsync(() => engine.execute(detection.id), 'UD_NOT_CONFIRMED');
    await expectUdErrorAsync(
      () => engine.execute(detection.id, { confirmed: false }),
      'UD_NOT_CONFIRMED',
    );

    assert.equal(exec.calls.length, 0);
    assert.equal(engine.get(detection.id).state, 'detected');
  });

  it('retry-once: transient failure then success → done, two attempts audited', async () => {
    const exec = fakeExecutor(['transient-once']);
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<https://example.com/u>',
    });

    const done = await engine.execute(detection.id, { confirmed: true });
    assert.equal(done.state, 'done');
    assert.equal(exec.calls.length, 2);
    assert.equal(done.attempts.length, 2);
    assert.equal(done.attempts[0].ok, false);
    assert.equal(done.attempts[0].transient, true);
    assert.equal(done.attempts[1].ok, true);
  });

  it('persistent transient failure → failed + UD_EXEC_FAILED after exactly one retry', async () => {
    const exec = fakeExecutor(['transient-forever']);
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<https://example.com/u>',
    });

    await expectUdErrorAsync(
      () => engine.execute(detection.id, { confirmed: true }),
      'UD_EXEC_FAILED',
    );
    assert.equal(exec.calls.length, 2, 'exactly one retry');
    assert.equal(engine.get(detection.id).state, 'failed');
    assert.equal(engine.get(detection.id).attempts.length, 2);
  });

  it('non-transient failure → no retry, failed + UD_EXEC_FAILED', async () => {
    const boom = new Error('bad request');
    boom.code = 'UD_EXEC_PERMANENT';
    const exec = fakeExecutor([boom]);
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<mailto:x@example.com>',
    });

    await expectUdErrorAsync(
      () => engine.execute(detection.id, { confirmed: true }),
      'UD_EXEC_FAILED',
    );
    assert.equal(exec.calls.length, 1, 'no retry on non-transient failure');
    assert.equal(engine.get(detection.id).state, 'failed');
  });

  it('re-executing a done detection → UD_INVALID_TRANSITION', async () => {
    const exec = fakeExecutor();
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<https://example.com/u>',
    });
    await engine.execute(detection.id, { confirmed: true });
    await expectUdErrorAsync(
      () => engine.execute(detection.id, { confirmed: true }),
      'UD_INVALID_TRANSITION',
    );
  });

  it('skip: detected → skipped; execute after skip → UD_INVALID_TRANSITION', async () => {
    const exec = fakeExecutor();
    const engine = createUnsubscribeEngine({ executor: exec });
    const detection = engine.detect({
      'List-Unsubscribe': '<https://example.com/u>',
    });
    const skipped = engine.skip(detection.id, 'user wants to keep the newsletter');
    assert.equal(skipped.state, 'skipped');
    await expectUdErrorAsync(
      () => engine.execute(detection.id, { confirmed: true }),
      'UD_INVALID_TRANSITION',
    );
  });

  it('detectBatch returns parallel detections with nulls for no-signal entries', () => {
    const engine = createUnsubscribeEngine({ executor: fakeExecutor() });
    const results = engine.detectBatch([
      { 'List-Unsubscribe': '<https://example.com/a>' },
      { 'List-Unsubscribe': 'garbage' },
      {},
      { 'List-Unsubscribe': '<mailto:bye@example.com>' },
    ]);
    assert.equal(results.length, 4);
    assert.equal(results[0].method, 'http');
    assert.equal(results[1], null);
    assert.equal(results[2], null);
    assert.equal(results[3].method, 'mailto');
  });

  it('get() returns null for unknown ids', () => {
    const engine = createUnsubscribeEngine({ executor: fakeExecutor() });
    assert.equal(engine.get('ud-nope'), null);
  });

  it('coded-error contract', async () => {
    const exec = fakeExecutor();
    const engine = createUnsubscribeEngine({ executor: exec });

    // UD_NOT_FOUND
    await expectUdErrorAsync(
      () => engine.execute('ud-unknown', { confirmed: true }),
      'UD_NOT_FOUND',
    );
    // UD_NO_SIGNAL on null input
    await expectUdErrorAsync(
      () => engine.execute(null, { confirmed: true }),
      'UD_NO_SIGNAL',
    );
    // UD_NO_SIGNAL via detect() null passthrough
    const nothing = engine.detect({ 'List-Unsubscribe': 'n/a' });
    assert.equal(nothing, null);
    await expectUdErrorAsync(
      () => engine.execute(nothing, { confirmed: true }),
      'UD_NO_SIGNAL',
    );
    // UD_NO_EXECUTOR
    const noExecEngine = createUnsubscribeEngine();
    const d = noExecEngine.detect({ 'List-Unsubscribe': '<https://example.com/u>' });
    await expectUdErrorAsync(
      () => noExecEngine.execute(d.id, { confirmed: true }),
      'UD_NO_EXECUTOR',
    );
    // UD_INVALID_TRANSITION on skip of unknown state
    expectUdErrorSync(() => engine.skip('ud-unknown', 'x'), 'UD_NOT_FOUND');

    // Every thrown error carries a string `code`.
    await assert.rejects(
      () => engine.execute('ud-missing', { confirmed: true }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(typeof err.code, 'string');
        return true;
      },
    );
  });
});
