/**
 * triage-execution.test.js — tests for the inbox.triage execution engine.
 *
 * Covers: happy path with rule matching, priority order, rule conflict skip,
 * dryRun purity, cancel mid-run, retry-once on transient failure, progress
 * accounting, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTriageExecution,
  ERROR_CODES,
  STATES,
} from '../src/triage-execution.mjs';

/** Controllable clock: { clock(), advance(ms) }. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

const ITEM = (id, extra = {}) => ({ id, ...extra });

const label = (name) => ({ type: 'label', label: name });
const archive = () => ({ type: 'archive' });

function expectTriageError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

/** Fake actionRunner that records calls; handlers decide behavior per call. */
function fakeRunner(handler = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    run(action, item) {
      calls.push({ action, item });
      return handler(action, item, calls.length);
    },
  };
}

function fakeStore(rules) {
  return { listRules: () => rules };
}

describe('triage-execution', () => {
  it('happy path: rules match, actions execute in priority order, run completes', () => {
    const runner = fakeRunner();
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        {
          id: 'newsletters',
          priority: 10,
          match: (item) => item.kind === 'newsletter',
          actions: [label('read-later')],
        },
        {
          id: 'important',
          priority: 1,
          match: (item) => item.kind === 'newsletter',
          actions: [label('priority')],
        },
      ]),
    });

    const created = engine.createRun([ITEM('a', { kind: 'newsletter' }), ITEM('b')]);
    assert.equal(created.state, 'idle');
    assert.equal(created.itemCount, 2);

    const finished = engine.startRun(created.id, 'agent');
    assert.equal(finished.state, 'completed');
    assert.ok(finished.startedAt <= finished.completedAt);

    // Item a matched both rules; item b matched none.
    const [dA, dB] = finished.decisions;
    assert.equal(dA.itemId, 'a');
    assert.deepEqual(dA.matchedRuleIds, ['important', 'newsletters']);
    assert.equal(dA.status, 'done');

    assert.equal(dB.itemId, 'b');
    assert.deepEqual(dB.matchedRuleIds, []);
    assert.equal(dB.status, 'done');
    assert.deepEqual(dB.actions, []);

    // Priority order: priority 1 ran before priority 10.
    assert.deepEqual(
      runner.calls.map((c) => c.action),
      [label('priority'), label('read-later')],
    );

    assert.deepEqual(engine.progress(created.id), { total: 2, done: 2, failed: 0 });

    // Starting again is an invalid transition.
    expectTriageError(() => engine.startRun(created.id), 'TE_INVALID_TRANSITION');
  });

  it('runs rules of equal priority in rule-id order', () => {
    const runner = fakeRunner();
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        { id: 'zeta', priority: 5, match: () => true, actions: [{ type: 'step-z' }] },
        { id: 'alpha', priority: 5, match: () => true, actions: [{ type: 'step-a' }] },
      ]),
    });
    const created = engine.createRun([ITEM('a')]);
    const finished = engine.startRun(created.id);
    assert.deepEqual(finished.decisions[0].matchedRuleIds, ['alpha', 'zeta']);
    assert.deepEqual(
      runner.calls.map((c) => c.action.type),
      ['step-a', 'step-z'],
    );
  });

  it('same-priority contradictory actions skip the item with TE_RULE_CONFLICT', () => {
    const runner = fakeRunner();
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        { id: 'rule-a', priority: 1, match: () => true, actions: [label('keep')] },
        { id: 'rule-b', priority: 1, match: () => true, actions: [label('toss')] },
      ]),
    });
    const created = engine.createRun([ITEM('a'), ITEM('b')]);
    const finished = engine.startRun(created.id);

    // Run still completes; both items skipped; nothing executed.
    assert.equal(finished.state, 'completed');
    assert.equal(runner.calls.length, 0);
    for (const decision of finished.decisions) {
      assert.equal(decision.status, 'skipped');
      assert.equal(decision.errorCode, 'TE_RULE_CONFLICT');
      assert.deepEqual(decision.conflict.ruleIds, ['rule-a', 'rule-b']);
    }
    assert.deepEqual(engine.progress(created.id), { total: 2, done: 0, failed: 2 });

    const auditEntry = engine.audit.find(
      (e) => e.event === 'item-decision' && e.detail.errorCode === 'TE_RULE_CONFLICT',
    );
    assert.ok(auditEntry, 'conflict lands in the audit log');
    assert.equal(auditEntry.detail.itemId, 'a');
  });

  it('different priorities with contradictory actions do NOT conflict (priority wins)', () => {
    const runner = fakeRunner();
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        { id: 'high', priority: 1, match: () => true, actions: [label('keep')] },
        { id: 'low', priority: 9, match: () => true, actions: [label('toss')] },
      ]),
    });
    const created = engine.createRun([ITEM('a')]);
    const finished = engine.startRun(created.id);
    assert.equal(finished.decisions[0].status, 'done');
    assert.deepEqual(
      runner.calls.map((c) => c.action.label),
      ['keep', 'toss'],
    );
  });

  it('same type with identical payload is not a conflict', () => {
    const runner = fakeRunner();
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        { id: 'r1', priority: 1, match: () => true, actions: [archive()] },
        { id: 'r2', priority: 1, match: () => true, actions: [archive()] },
      ]),
    });
    const created = engine.createRun([ITEM('a')]);
    const finished = engine.startRun(created.id);
    assert.equal(finished.decisions[0].status, 'done');
    assert.equal(runner.calls.length, 2);
  });

  it('dryRun evaluates rules but never calls the actionRunner', () => {
    const runner = fakeRunner();
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        { id: 'r1', priority: 1, match: (item) => item.kind === 'x', actions: [archive()] },
      ]),
    });
    const created = engine.createRun(
      [ITEM('a', { kind: 'x' }), ITEM('b')],
      { dryRun: true },
    );
    assert.equal(created.dryRun, true);

    const finished = engine.startRun(created.id);
    assert.equal(finished.state, 'completed');
    assert.equal(runner.calls.length, 0, 'actionRunner must stay pure in dryRun');

    const [dA, dB] = finished.decisions;
    assert.equal(dA.status, 'done');
    assert.equal(dA.dryRun, true);
    assert.deepEqual(dA.matchedRuleIds, ['r1']);
    assert.deepEqual(dA.actions, [archive()]);
    assert.ok(dA.results.every((r) => r.dryRun === true && r.ok === true));
    assert.deepEqual(dB.matchedRuleIds, []);

    assert.deepEqual(engine.progress(created.id), { total: 2, done: 2, failed: 0 });
  });

  it('cancel mid-run stops after the current item and marks the run cancelled', () => {
    let engine;
    const runner = fakeRunner(() => {
      // Cancel while the first item is being processed.
      engine.cancelRun(runId);
      return { ok: true };
    });
    engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [archive()] }]),
    });
    const created = engine.createRun([ITEM('a'), ITEM('b'), ITEM('c')]);
    const runId = created.id;

    const finished = engine.startRun(runId);
    assert.equal(finished.state, 'cancelled');
    assert.equal(finished.decisions.length, 1, 'remaining items are not processed');
    assert.equal(finished.decisions[0].itemId, 'a');
    assert.deepEqual(engine.progress(runId), { total: 3, done: 1, failed: 0 });

    const last = engine.audit.at(-1);
    assert.equal(last.event, 'run-transition');
    assert.equal(last.detail.from, 'running');
    assert.equal(last.detail.to, 'cancelled');

    // Cancelling a finished run is invalid.
    expectTriageError(() => engine.cancelRun(runId), 'TE_INVALID_TRANSITION');
  });

  it('retries exactly once on transient action failure, then succeeds', () => {
    let attempts = 0;
    const runner = fakeRunner(() => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('flaky provider');
        err.transient = true;
        throw err;
      }
      return { ok: true };
    });
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [archive()] }]),
    });
    const created = engine.createRun([ITEM('a')]);
    const finished = engine.startRun(created.id);
    const decision = finished.decisions[0];
    assert.equal(decision.status, 'done');
    assert.equal(decision.results[0].ok, true);
    assert.equal(decision.results[0].retried, true);
    assert.equal(attempts, 2, 'exactly one retry');
    assert.deepEqual(engine.progress(created.id), { total: 1, done: 1, failed: 0 });
  });

  it('transient errors with code TE_ACTION_TRANSIENT are retried too', () => {
    let attempts = 0;
    const runner = fakeRunner(() => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('rate limited');
        err.code = 'TE_ACTION_TRANSIENT';
        throw err;
      }
      return { ok: true };
    });
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [archive()] }]),
    });
    const created = engine.createRun([ITEM('a')]);
    const finished = engine.startRun(created.id);
    assert.equal(finished.decisions[0].results[0].ok, true);
    assert.equal(attempts, 2);
  });

  it('non-transient failure is not retried; item fails; run continues', () => {
    const runner = fakeRunner((action) => {
      if (action.type === 'label') throw new Error('permanent deny');
      return { ok: true };
    });
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        { id: 'r1', priority: 1, match: (item) => item.id === 'a', actions: [label('x')] },
        { id: 'r2', priority: 1, match: (item) => item.id === 'b', actions: [archive()] },
      ]),
    });
    const created = engine.createRun([ITEM('a'), ITEM('b')]);
    const finished = engine.startRun(created.id);
    assert.equal(finished.state, 'completed');

    const [dA, dB] = finished.decisions;
    assert.equal(dA.status, 'failed');
    assert.equal(dA.errorCode, 'TE_ACTION_FAILED');
    assert.equal(dA.results[0].ok, false);
    assert.equal(dA.results[0].retried, false, 'no retry for non-transient');
    assert.equal(dA.results[0].error, 'permanent deny');

    assert.equal(dB.status, 'done', 'run continues after a failed item');
    assert.deepEqual(engine.progress(created.id), { total: 2, done: 1, failed: 1 });
  });

  it('exhausted retry (transient twice) fails the item', () => {
    const runner = fakeRunner(() => {
      const err = new Error('still down');
      err.transient = true;
      throw err;
    });
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [archive()] }]),
    });
    const created = engine.createRun([ITEM('a')]);
    const finished = engine.startRun(created.id);
    const decision = finished.decisions[0];
    assert.equal(decision.status, 'failed');
    assert.equal(decision.results[0].retried, true);
    assert.equal(runner.calls.length, 2, 'one attempt + one retry');
  });

  it('item stops its remaining actions after the first failure', () => {
    const order = [];
    const runner = fakeRunner((action) => {
      order.push(action.type);
      if (action.type === 'label') throw new Error('boom');
      return { ok: true };
    });
    const engine = createTriageExecution({
      actionRunner: runner,
      ruleStore: fakeStore([
        {
          id: 'r1',
          priority: 1,
          match: () => true,
          actions: [label('x'), archive()],
        },
      ]),
    });
    const created = engine.createRun([ITEM('a')]);
    engine.startRun(created.id);
    assert.deepEqual(order, ['label'], 'archive never runs after the label failed');
  });

  it('unknown run ids throw TE_NOT_FOUND', () => {
    const engine = createTriageExecution({});
    for (const fn of [
      () => engine.startRun('nope'),
      () => engine.cancelRun('nope'),
      () => engine.progress('nope'),
    ]) {
      expectTriageError(fn, 'TE_NOT_FOUND');
    }
    assert.equal(engine.get('nope'), null);
  });

  it('startRun without an actionRunner throws TE_ACTION_FAILED (non-dryRun)', () => {
    const engine = createTriageExecution({
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [] }]),
    });
    const created = engine.createRun([ITEM('a')]);
    expectTriageError(() => engine.startRun(created.id), 'TE_ACTION_FAILED');
    assert.equal(engine.get(created.id).state, 'idle', 'run stays idle on failed start');
  });

  it('dryRun does not need an actionRunner', () => {
    const engine = createTriageExecution({
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [archive()] }]),
    });
    const created = engine.createRun([ITEM('a')], { dryRun: true });
    const finished = engine.startRun(created.id);
    assert.equal(finished.state, 'completed');
  });

  it('ruleStore failure moves the run to failed and throws TE_ACTION_FAILED', () => {
    const engine = createTriageExecution({
      actionRunner: fakeRunner(),
      ruleStore: { listRules: () => { throw new Error('store exploded'); } },
    });
    const created = engine.createRun([ITEM('a')]);
    expectTriageError(() => engine.startRun(created.id), 'TE_ACTION_FAILED');
    const snap = engine.get(created.id);
    assert.equal(snap.state, 'failed');
    const last = engine.audit.at(-1);
    assert.equal(last.event, 'run-transition');
    assert.equal(last.detail.to, 'failed');
  });

  it('malformed rules are fatal: TE_ACTION_FAILED, run failed', () => {
    const engine = createTriageExecution({
      actionRunner: fakeRunner(),
      ruleStore: fakeStore([{ id: 'bad' }]), // no match, no actions
    });
    const created = engine.createRun([ITEM('a')]);
    expectTriageError(() => engine.startRun(created.id), 'TE_ACTION_FAILED');
    assert.equal(engine.get(created.id).state, 'failed');
  });

  it('createRun requires an items array: TE_ACTION_FAILED', () => {
    const engine = createTriageExecution({});
    expectTriageError(() => engine.createRun('not-an-array'), 'TE_ACTION_FAILED');
  });

  it('audit log is append-only and covers the run lifecycle', () => {
    const { clock, advance } = fakeClock();
    const engine = createTriageExecution({
      clock,
      actionRunner: fakeRunner(),
      ruleStore: fakeStore([{ id: 'r1', priority: 1, match: () => true, actions: [archive()] }]),
    });
    const created = engine.createRun([ITEM('a')]);
    advance(5);
    engine.startRun(created.id, 'agent');

    const events = engine.audit.map((e) => e.event);
    assert.deepEqual(events, [
      'run-created',
      'run-transition', // idle -> running
      'item-decision',
      'run-transition', // running -> completed
    ]);
    for (const entry of engine.audit) {
      assert.ok(typeof entry.at === 'number');
      assert.ok('event' in entry && 'runId' in entry && 'actor' in entry && 'detail' in entry);
      assert.equal(entry.runId, created.id);
    }
    const [t1, t2] = engine.audit.filter((e) => e.event === 'run-transition');
    assert.deepEqual([t1.detail.from, t1.detail.to], ['idle', 'running']);
    assert.deepEqual([t2.detail.from, t2.detail.to], ['running', 'completed']);
  });

  it('STATES and ERROR_CODES exports cover the contract', () => {
    assert.deepEqual([...STATES].sort(), [
      'cancelled',
      'completed',
      'failed',
      'idle',
      'running',
    ]);
    assert.deepEqual([...ERROR_CODES].sort(), [
      'TE_ACTION_FAILED',
      'TE_INVALID_TRANSITION',
      'TE_NOT_FOUND',
      'TE_RULE_CONFLICT',
    ]);
  });
});
