/**
 * Tests for src/failover-provider-wireup.mjs — pure failover planner.
 *
 * node:test + node:assert/strict. Fake clock, fake senders, fake health
 * checker. No network, no timers, no real time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFailover,
  CIRCUIT_STATES,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
} from '../src/failover-provider-wireup.mjs';

/** Controllable clock. */
function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function senderThat(log, name, outcome) {
  return async (payload) => {
    log.push({ provider: name, payload });
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'function') return outcome(payload);
    return outcome;
  };
}

function makeFailover({ clock, providers, healthChecker, failureThreshold, cooldownMs } = {}) {
  const log = [];
  let n = 0;
  const mk = (name, priority, outcome = { ok: name }) => ({
    name,
    sender: senderThat(log, name, outcome),
    priority,
  });
  const built = (providers ?? [mk('a', 1), mk('b', 2), mk('c', 3)]).map((p) =>
    p.sender && p.name ? p : mk(p.name, p.priority, p.outcome),
  );
  const fo = createFailover({
    clock: clock?.now,
    id: () => `test-${(n += 1)}`,
    providers: built,
    healthChecker,
    failureThreshold,
    cooldownMs,
  });
  return { fo, log };
}

describe('failover-provider-wireup', () => {
  it('exposes expected defaults and circuit states', () => {
    assert.deepEqual([...CIRCUIT_STATES], ['closed', 'open', 'half-open']);
    assert.equal(DEFAULT_FAILURE_THRESHOLD, 3);
    assert.equal(DEFAULT_COOLDOWN_MS, 60 * 1000);
  });

  it('throws FO_NO_PROVIDERS for empty or malformed provider lists', () => {
    assert.throws(() => createFailover({}), /at least one provider/);
    const e1 = catchCode(() => createFailover({ providers: [] }));
    assert.equal(e1, 'FO_NO_PROVIDERS');
    const e2 = catchCode(() => createFailover({ providers: [{ name: 'x' }] }));
    assert.equal(e2, 'FO_NO_PROVIDERS');
  });

  it('uses the highest-priority (lowest number) provider first', async (t) => {
    const { fo, log } = makeFailover({});
    const res = await fo.send({ to: 'john@example.com' });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'a');
    assert.deepEqual(log.map((l) => l.provider), ['a']);
    assert.equal(res.attempts.length, 1);
    assert.equal(res.attempts[0].ok, true);
    assert.equal(res.attempts[0].provider, 'a');
    assert.equal(typeof res.attempts[0].latencyMs, 'number');
  });

  it('fails over to the next provider on sender failure', async (t) => {
    const clock = fakeClock();
    const log = [];
    const fo = createFailover({
      clock: clock.now,
      providers: [
        { name: 'a', sender: senderThat(log, 'a', new Error('boom')), priority: 1 },
        { name: 'b', sender: senderThat(log, 'b', { delivered: true }), priority: 2 },
        { name: 'c', sender: senderThat(log, 'c', { delivered: true }), priority: 3 },
      ],
    });
    const res = await fo.send({ msg: 'hi' });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'b');
    assert.deepEqual(log.map((l) => l.provider), ['a', 'b']);
    assert.equal(res.attempts.length, 2);
    assert.equal(res.attempts[0].code, 'FO_PROVIDER_FAILED');
    assert.equal(res.attempts[0].ok, false);
    assert.ok(res.attempts[0].error instanceof Error);
    assert.equal(res.attempts[1].ok, true);
  });

  it('opens the circuit after N consecutive failures and skips the provider', async (t) => {
    const clock = fakeClock();
    const log = [];
    const fo = createFailover({
      clock: clock.now,
      failureThreshold: 3,
      providers: [
        { name: 'flaky', sender: senderThat(log, 'flaky', new Error('down')), priority: 1 },
        { name: 'backup', sender: senderThat(log, 'backup', { ok: true }), priority: 2 },
      ],
    });

    await fo.send({}); // flaky fails 1
    await fo.send({}); // flaky fails 2
    await fo.send({}); // flaky fails 3 -> circuit opens
    assert.equal(fo.stats('flaky').circuitState, 'open');

    const res = await fo.send({});
    assert.equal(res.provider, 'backup');
    // flaky was skipped: only backup attempted, skip recorded in audit
    assert.deepEqual(
      res.attempts.map((a) => [a.provider, a.code]),
      [
        ['flaky', 'FO_CIRCUIT_OPEN'],
        ['backup', null],
      ],
    );
    assert.deepEqual(log.map((l) => l.provider), ['flaky', 'backup', 'flaky', 'backup', 'flaky', 'backup', 'backup']);
  });

  it('half-open probe after cooldown: success closes the circuit', async (t) => {
    const clock = fakeClock();
    const outcomes = [new Error('x'), new Error('x'), { recovered: true }];
    const log = [];
    let calls = 0;
    const fo = createFailover({
      clock: clock.now,
      failureThreshold: 2,
      cooldownMs: 60_000,
      providers: [
        {
          name: 'flaky',
          priority: 1,
          sender: async () => {
            calls += 1;
            const out = outcomes[Math.min(calls - 1, outcomes.length - 1)];
            if (out instanceof Error) throw out;
            return out;
          },
        },
        { name: 'backup', sender: senderThat(log, 'backup', { ok: true }), priority: 2 },
      ],
    });

    await fo.send({}); // fail 1
    await fo.send({}); // fail 2 -> open
    assert.equal(fo.stats('flaky').circuitState, 'open');

    clock.advance(59_999);
    await fo.send({});
    assert.equal(fo.stats('flaky').circuitState, 'open'); // still open

    clock.advance(1); // exactly at cooldown -> half-open probe
    const res = await fo.send({});
    assert.equal(res.provider, 'flaky');
    assert.equal(fo.stats('flaky').circuitState, 'closed');
    assert.equal(fo.stats('flaky').consecutiveFailures, 0);
  });

  it('half-open probe failure re-opens the circuit with a fresh cooldown', async (t) => {
    const clock = fakeClock();
    const fo = createFailover({
      clock: clock.now,
      failureThreshold: 2,
      cooldownMs: 60_000,
      providers: [
        {
          name: 'flaky',
          priority: 1,
          sender: async () => {
            throw new Error('still down');
          },
        },
        { name: 'backup', sender: async () => ({ ok: true }), priority: 2 },
      ],
    });

    await fo.send({});
    await fo.send({});
    assert.equal(fo.stats('flaky').circuitState, 'open');

    clock.advance(60_000);
    const res = await fo.send({});
    assert.equal(res.provider, 'backup');
    assert.equal(fo.stats('flaky').circuitState, 'open'); // re-opened by failed probe
    assert.equal(res.attempts[0].provider, 'flaky');
    assert.equal(res.attempts[0].code, 'FO_PROVIDER_FAILED');

    // fresh cooldown required before the next probe
    clock.advance(59_999);
    await fo.send({});
    assert.equal(
      (await fo.send({})).attempts[0].code,
      'FO_CIRCUIT_OPEN',
      'probe not admitted before fresh cooldown elapses',
    );
  });

  it('pinProvider restricts sends to the pinned provider; unpin restores priority order', async (t) => {
    const clock = fakeClock();
    const log = [];
    const fo = createFailover({
      clock: clock.now,
      providers: [
        { name: 'a', sender: senderThat(log, 'a', { ok: 'a' }), priority: 1 },
        { name: 'b', sender: senderThat(log, 'b', { ok: 'b' }), priority: 5 },
      ],
    });

    assert.equal(fo.pinProvider('b'), 'b');
    assert.equal(fo.pinned, 'b');
    const res = await fo.send({});
    assert.equal(res.provider, 'b');
    assert.equal(res.attempts.length, 1);

    assert.equal(fo.unpin(), null);
    assert.equal(fo.pinned, null);
    const res2 = await fo.send({});
    assert.equal(res2.provider, 'a');
  });

  it('pinProvider on unknown name throws FO_NOT_FOUND; unpin with no pin throws FO_INVALID_TRANSITION', (t) => {
    const { fo } = makeFailover({});
    assert.equal(catchCode(() => fo.pinProvider('nope')), 'FO_NOT_FOUND');
    assert.equal(catchCode(() => fo.unpin()), 'FO_INVALID_TRANSITION');
    assert.equal(catchCode(() => fo.stats('nope')), 'FO_NOT_FOUND');
    assert.equal(catchCode(() => fo.resetProvider('nope')), 'FO_NOT_FOUND');
  });

  it('all providers failing throws FO_ALL_FAILED with the attempts audit', async (t) => {
    const clock = fakeClock();
    const fo = createFailover({
      clock: clock.now,
      failureThreshold: 10,
      providers: [
        { name: 'a', sender: async () => { throw new Error('a down'); }, priority: 1 },
        { name: 'b', sender: async () => { throw new Error('b down'); }, priority: 2 },
      ],
    });
    let err;
    try {
      await fo.send({ msg: 'x' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'send should throw');
    assert.equal(err.code, 'FO_ALL_FAILED');
    assert.equal(err.detail.attempts.length, 2);
    assert.deepEqual(
      err.detail.attempts.map((a) => a.provider),
      ['a', 'b'],
    );
    assert.ok(err.detail.attempts.every((a) => a.ok === false && a.code === 'FO_PROVIDER_FAILED'));
    // audit recorded the failed send too
    assert.equal(fo.audit.length, 1);
    assert.equal(fo.audit[0].provider, null);
    assert.equal(fo.audit[0].attempts.length, 2);
  });

  it('stats track successes, failures, and circuit state per provider', async (t) => {
    const clock = fakeClock();
    const fo = createFailover({
      clock: clock.now,
      failureThreshold: 2,
      providers: [
        { name: 'good', sender: async () => ({ ok: true }), priority: 1 },
        { name: 'bad', sender: async () => { throw new Error('no'); }, priority: 2 },
      ],
    });

    await fo.send({}); // good succeeds
    await fo.send({}); // good succeeds

    // force the bad provider to take the send via pin
    fo.pinProvider('bad');
    await assert.rejects(() => fo.send({}));
    await assert.rejects(() => fo.send({}));
    fo.unpin();

    const good = fo.stats('good');
    assert.deepEqual(
      { successes: good.successes, failures: good.failures, circuitState: good.circuitState },
      { successes: 2, failures: 0, circuitState: 'closed' },
    );
    const bad = fo.stats('bad');
    assert.equal(bad.successes, 0);
    assert.equal(bad.failures, 2);
    assert.equal(bad.circuitState, 'open');
    assert.equal(bad.consecutiveFailures, 2);

    const all = fo.stats();
    assert.equal(all.length, 2);
    assert.ok(Object.isFrozen(all[0]));

    // resetProvider closes the circuit
    fo.resetProvider('bad');
    assert.equal(fo.stats('bad').circuitState, 'closed');
    assert.equal(fo.stats('bad').consecutiveFailures, 0);
  });

  it('skips providers the healthChecker marks unhealthy', async (t) => {
    const clock = fakeClock();
    const log = [];
    const fo = createFailover({
      clock: clock.now,
      healthChecker: (name) => name !== 'sick',
      providers: [
        { name: 'sick', sender: senderThat(log, 'sick', { ok: true }), priority: 1 },
        { name: 'well', sender: senderThat(log, 'well', { ok: true }), priority: 2 },
      ],
    });
    const res = await fo.send({});
    assert.equal(res.provider, 'well');
    assert.deepEqual(
      res.attempts.map((a) => [a.provider, a.code]),
      [
        ['sick', 'FO_PROVIDER_UNHEALTHY'],
        ['well', null],
      ],
    );
    assert.deepEqual(log.map((l) => l.provider), ['well']);
  });

  it('coded-error contract: every thrown error carries a FO_* code', async (t) => {
    const clock = fakeClock();
    const fo = createFailover({
      clock: clock.now,
      providers: [{ name: 'a', sender: async () => { throw new Error('x'); }, priority: 1 }],
    });
    const errs = [];
    try {
      await fo.send({});
    } catch (e) {
      errs.push(e);
    }
    for (const op of [
      () => fo.pinProvider('missing'),
      () => fo.unpin(),
      () => fo.stats('missing'),
      () => createFailover({ providers: [] }),
    ]) {
      try {
        op();
      } catch (e) {
        errs.push(e);
      }
    }
    assert.ok(errs.length > 0);
    for (const e of errs) {
      assert.ok(/^FO_[A-Z_]+$/.test(e.code), `code ${e.code} matches FO_* contract`);
      assert.ok(e instanceof Error);
    }
  });
});

function catchCode(fn) {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  assert.fail('expected a throw');
}
