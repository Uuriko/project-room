/**
 * bulk-unsubscribe.test.js — tests for the one-click unsubscribe execution planner.
 *
 * Covers: method resolution order (one-click → http → mailto, BU_NO_METHOD),
 * happy path all-ok → done, mixed results → partial, all-fail → failed
 * (BU_UNSUB_FAILED), retry-once on transient failure, unconfirmed rejection
 * (BU_NOT_CONFIRMED), dryRun purity, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBulkUnsubscriber, STATES, METHODS } from '../src/bulk-unsubscribe.mjs';

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

/** Fake unsubscriber: scripted per-list outcomes. */
function fakeUnsubscriber({ calls, behaviors }) {
  return {
    unsubscribe: (listId, method) => {
      calls.push({ listId, method });
      const behavior = behaviors[listId];
      if (typeof behavior === 'function') return behavior(listId, method);
      if (behavior instanceof Error) throw behavior;
      if (behavior === 'fail') throw new Error(`unsub failed for ${listId}`);
      return { ok: true };
    },
  };
}

function plannerWith(calls, behaviors = {}, depOverrides = {}) {
  return {
    calls,
    planner: createBulkUnsubscriber({
      clock: fakeClock().clock,
      id: (() => { let n = 0; return () => `job-${(n += 1)}`; })(),
      unsubscriber: fakeUnsubscriber({ calls, behaviors }),
      ...depOverrides,
    }),
  };
}

const LISTS = {
  oneClickHttpMailto: [
    { id: 'l1', supports: ['one-click', 'http', 'mailto'] },
    { id: 'l2', supports: ['one-click', 'mailto'] },
  ],
  httpOnly: [
    { id: 'l1', supports: ['http', 'mailto'] },
    { id: 'l2', supports: ['http'] },
  ],
  mailtoOnly: [
    { id: 'l1', supports: ['mailto'] },
    { id: 'l2', supports: ['mailto'] },
  ],
  disjoint: [
    { id: 'l1', supports: ['one-click'] },
    { id: 'l2', supports: ['mailto'] },
  ],
  noMethods: [{ id: 'l1', supports: [] }],
};

function expectBuError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('bulk-unsubscribe', () => {
  it('exports STATES and METHODS', () => {
    assert.deepEqual([...STATES], ['queued', 'executing', 'done', 'failed', 'partial', 'skipped']);
    assert.deepEqual([...METHODS], ['one-click', 'http', 'mailto']);
  });

  it('requires an unsubscriber dep at construction (BU_NO_UNSUBSCRIBER)', () => {
    expectBuError(() => createBulkUnsubscriber(), 'BU_NO_UNSUBSCRIBER');
    expectBuError(() => createBulkUnsubscriber({ unsubscriber: {} }), 'BU_NO_UNSUBSCRIBER');
  });

  it('method resolution: prefers one-click over http and mailto', () => {
    const { planner } = plannerWith([]);
    const job = planner.queue('news@example.com', LISTS.oneClickHttpMailto);
    assert.equal(job.method, 'one-click');
    assert.equal(job.state, 'queued');
    assert.deepEqual(job.listIds, ['l1', 'l2']);
  });

  it('method resolution: http when one-click is not common, mailto as fallback', () => {
    const { planner } = plannerWith([]);
    assert.equal(planner.queue('a@example.com', LISTS.httpOnly).method, 'http');
    assert.equal(planner.queue('b@example.com', LISTS.mailtoOnly).method, 'mailto');
  });

  it('method resolution: BU_NO_METHOD when no method is common to all lists', () => {
    const { planner } = plannerWith([]);
    expectBuError(() => planner.queue('x@example.com', LISTS.disjoint), 'BU_NO_METHOD');
    expectBuError(() => planner.queue('y@example.com', LISTS.noMethods), 'BU_NO_METHOD');
    expectBuError(() => planner.queue('z@example.com', []), 'BU_NO_LISTS');
  });

  it('happy path: all-ok → done, per-list calls with resolved method', () => {
    const { calls, planner } = plannerWith([]);
    const queued = planner.queue('news@example.com', LISTS.oneClickHttpMailto, 'john');
    assert.equal(queued.state, 'queued');

    const done = planner.execute(queued.id, { confirmed: true }, 'john');
    assert.equal(done.state, 'done');
    assert.equal(done.results.length, 2);
    assert.ok(done.results.every((r) => r.ok && r.attempts === 1));
    assert.deepEqual(
      calls.map((c) => c.listId),
      ['l1', 'l2'],
    );
    assert.ok(calls.every((c) => c.method === 'one-click'));
  });

  it('mixed results → partial; failures recorded per-list, never silent', () => {
    const { planner } = plannerWith([], { l2: 'fail' });
    const job = planner.queue('news@example.com', LISTS.httpOnly);
    const result = planner.execute(job.id, { confirmed: true });
    assert.equal(result.state, 'partial');
    assert.equal(result.results.filter((r) => r.ok).length, 1);
    const failed = result.results.find((r) => r.listId === 'l2');
    assert.equal(failed.ok, false);
    assert.ok(failed.errorMessage, 'failure recorded');
  });

  it('all-fail → failed state and throws BU_UNSUB_FAILED', () => {
    const { planner } = plannerWith([], { l1: 'fail', l2: 'fail' });
    const job = planner.queue('news@example.com', LISTS.mailtoOnly);
    expectBuError(() => planner.execute(job.id, { confirmed: true }), 'BU_UNSUB_FAILED');
    assert.equal(planner.get(job.id).state, 'failed');
    assert.equal(planner.get(job.id).results.length, 2);
  });

  it('retry-once: transient failure succeeds on the second attempt', () => {
    let callsForL1 = 0;
    const { calls, planner } = plannerWith([], {
      l1: () => {
        callsForL1 += 1;
        if (callsForL1 === 1) {
          const err = new Error('timeout');
          err.transient = true;
          throw err;
        }
        return { ok: true };
      },
    });
    const job = planner.queue('news@example.com', LISTS.oneClickHttpMailto);
    const done = planner.execute(job.id, { confirmed: true });
    assert.equal(done.state, 'done');
    assert.equal(calls.filter((c) => c.listId === 'l1').length, 2);
    assert.equal(done.results.find((r) => r.listId === 'l1').attempts, 2);
  });

  it('retry-once: transient failure twice counts as failed, no third attempt', () => {
    const transientErr = new Error('flaky');
    transientErr.transient = true;
    const { calls, planner } = plannerWith([], { l1: transientErr, l2: 'fail' });
    const job = planner.queue('news@example.com', LISTS.oneClickHttpMailto);
    expectBuError(() => planner.execute(job.id, { confirmed: true }), 'BU_UNSUB_FAILED');
    assert.equal(calls.filter((c) => c.listId === 'l1').length, 2, 'exactly two attempts');
  });

  it('non-transient failure is NOT retried', () => {
    const { calls, planner } = plannerWith([], { l1: 'fail' });
    const job = planner.queue('news@example.com', LISTS.httpOnly);
    const result = planner.execute(job.id, { confirmed: true });
    assert.equal(result.state, 'partial');
    assert.equal(calls.filter((c) => c.listId === 'l1').length, 1);
  });

  it('execute without explicit confirmation → BU_NOT_CONFIRMED, stays queued', () => {
    const { calls, planner } = plannerWith([]);
    const job = planner.queue('news@example.com', LISTS.mailtoOnly);
    expectBuError(() => planner.execute(job.id), 'BU_NOT_CONFIRMED');
    expectBuError(() => planner.execute(job.id, { confirmed: false }), 'BU_NOT_CONFIRMED');
    assert.equal(planner.get(job.id).state, 'queued');
    assert.equal(calls.length, 0, 'no unsubscribe call was made');
  });

  it('execute twice → BU_INVALID_TRANSITION on the second call', () => {
    const { planner } = plannerWith([]);
    const job = planner.queue('news@example.com', LISTS.mailtoOnly);
    planner.execute(job.id, { confirmed: true });
    expectBuError(() => planner.execute(job.id, { confirmed: true }), 'BU_INVALID_TRANSITION');
  });

  it('execute unknown id → BU_NOT_FOUND', () => {
    const { planner } = plannerWith([]);
    expectBuError(() => planner.execute('nope', { confirmed: true }), 'BU_NOT_FOUND');
  });

  it('dryRun: resolves method + count without executing or creating a job', () => {
    const { calls, planner } = plannerWith([]);
    const plan = planner.dryRun('news@example.com', LISTS.oneClickHttpMailto);
    assert.equal(plan.method, 'one-click');
    assert.equal(plan.listCount, 2);
    assert.deepEqual(plan.listIds, ['l1', 'l2']);
    assert.equal(calls.length, 0, 'dryRun makes no unsubscribe calls');
    assert.equal(planner.get('job-1'), null, 'dryRun creates no job');
  });

  it('dryRun errors mirror queue errors (BU_NO_METHOD, BU_NO_LISTS)', () => {
    const { planner } = plannerWith([]);
    expectBuError(() => planner.dryRun('x@example.com', LISTS.disjoint), 'BU_NO_METHOD');
    expectBuError(() => planner.dryRun('x@example.com', []), 'BU_NO_LISTS');
  });

  it('coded-error contract: every failure carries a BU_ code', () => {
    const { planner } = plannerWith([], { l1: 'fail', l2: 'fail' });
    const job = planner.queue('news@example.com', LISTS.mailtoOnly);
    assert.throws(() => planner.execute(job.id, { confirmed: true }), (err) => {
      assert.match(err.code, /^BU_[A-Z_]+$/);
      assert.ok(err.detail, 'detail present');
      return true;
    });
  });

  it('audit log records every transition in order', () => {
    const { planner } = plannerWith([]);
    const job = planner.queue('news@example.com', LISTS.mailtoOnly, 'john');
    planner.execute(job.id, { confirmed: true }, 'john');
    const transitions = planner.audit
      .filter((e) => e.detail?.jobId === job.id && e.from !== e.to)
      .map((e) => e.to);
    assert.deepEqual(transitions, ['queued', 'executing', 'done']);
  });

  it('get returns null for unknown ids; snapshots are frozen', () => {
    const { planner } = plannerWith([]);
    assert.equal(planner.get('nope'), null);
    const job = planner.queue('news@example.com', LISTS.mailtoOnly);
    assert.ok(Object.isFrozen(job));
    assert.ok(Object.isFrozen(job.listIds));
  });
});
