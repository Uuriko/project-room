/**
 * message-edit-sync.test.js — tests for the message edit/delete sync planner.
 *
 * Covers: capability matrix per channel (telegram edit in/out of window,
 * whatsapp edit/delete windows, email edit unsupported / delete retract-only),
 * planner output correctness, execution happy path, retry-once on transient
 * syncer failure, fail-fast on unsupported intents (syncer never called),
 * invalid transitions, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessageEditSync,
  planIntent,
  STATES,
  ACTIONS,
  DEFAULT_MATRIX,
  TELEGRAM_EDIT_WINDOW_MS,
  WHATSAPP_EDIT_WINDOW_MS,
  WHATSAPP_DELETE_WINDOW_MS,
} from '../src/message-edit-sync.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
function fakeClock(start = 1_000_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

function transientError(message = 'boom') {
  const err = new Error(message);
  err.transient = true;
  return err;
}

function expectMesError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

async function expectMesErrorAsync(fn, code) {
  await assert.rejects(fn(), (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

const editIntent = (overrides = {}) => ({
  channel: 'telegram',
  messageId: 'msg-1',
  sentAt: 1_000_000_000,
  kind: 'edit',
  newText: 'edited text',
  ...overrides,
});

describe('message-edit-sync: capability matrix', () => {
  it('exports STATES, ACTIONS, and the window constants', () => {
    assert.deepEqual([...STATES], ['planned', 'syncing', 'synced', 'failed', 'unsupported']);
    assert.deepEqual([...ACTIONS], ['edit', 'delete', 'retract-request', 'unsupported']);
    assert.equal(TELEGRAM_EDIT_WINDOW_MS, 48 * 60 * 60 * 1000);
    assert.equal(WHATSAPP_EDIT_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(WHATSAPP_DELETE_WINDOW_MS, 48 * 60 * 60 * 1000);
    assert.ok(Object.isFrozen(DEFAULT_MATRIX));
  });

  it('telegram edit inside 48h → edit', () => {
    const t = fakeClock();
    const plan = planIntent(editIntent({ sentAt: t.box.now - 60 * 60 * 1000 }), DEFAULT_MATRIX, t.box.now);
    assert.equal(plan.action, 'edit');
    assert.ok(plan.reason.length > 0);
  });

  it('telegram edit exactly at the 48h boundary is still in-window', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ sentAt: t.box.now - TELEGRAM_EDIT_WINDOW_MS }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'edit');
  });

  it('telegram edit beyond 48h → unsupported with MES_WINDOW_EXPIRED', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ sentAt: t.box.now - (48 * 60 * 60 * 1000 + 1) }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'unsupported');
    assert.equal(plan.failureCode, 'MES_WINDOW_EXPIRED');
    assert.match(plan.reason, /window expired/i);
  });

  it('telegram delete is allowed anytime (30 days later still works)', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ kind: 'delete', sentAt: t.box.now - 30 * 24 * 60 * 60 * 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'delete');
  });

  it('whatsapp edit inside 15min → edit', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ channel: 'whatsapp', sentAt: t.box.now - 5 * 60 * 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'edit');
  });

  it('whatsapp edit beyond 15min → unsupported with MES_WINDOW_EXPIRED', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ channel: 'whatsapp', sentAt: t.box.now - 20 * 60 * 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'unsupported');
    assert.equal(plan.failureCode, 'MES_WINDOW_EXPIRED');
  });

  it('whatsapp delete inside ~2 days → delete; after 3 days → unsupported', () => {
    const t = fakeClock();
    const inWindow = planIntent(
      editIntent({ channel: 'whatsapp', kind: 'delete', sentAt: t.box.now - 60 * 60 * 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(inWindow.action, 'delete');

    const outWindow = planIntent(
      editIntent({ channel: 'whatsapp', kind: 'delete', sentAt: t.box.now - 3 * 24 * 60 * 60 * 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(outWindow.action, 'unsupported');
    assert.equal(outWindow.failureCode, 'MES_WINDOW_EXPIRED');
  });

  it('email edit → unsupported with MES_UNSUPPORTED', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ channel: 'email', sentAt: t.box.now - 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'unsupported');
    assert.equal(plan.failureCode, 'MES_UNSUPPORTED');
    assert.match(plan.reason, /cannot be edited/i);
  });

  it('email delete → retract-request (not delete)', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ channel: 'email', kind: 'delete', sentAt: t.box.now - 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'retract-request');
    assert.match(plan.reason, /retract/i);
  });

  it('unknown channel → unsupported with MES_UNSUPPORTED', () => {
    const t = fakeClock();
    const plan = planIntent(
      editIntent({ channel: 'carrier-pigeon', sentAt: t.box.now - 1000 }),
      DEFAULT_MATRIX,
      t.box.now,
    );
    assert.equal(plan.action, 'unsupported');
    assert.equal(plan.failureCode, 'MES_UNSUPPORTED');
  });

  it('matrix override can tighten a window', () => {
    const t = fakeClock();
    const planner = createMessageEditSync({
      clock: t.clock,
      matrix: { telegram: { edit: { windowMs: 60 * 1000 } } },
    });
    const inWindow = planner.plan(editIntent({ sentAt: t.box.now - 30 * 1000 }));
    assert.equal(inWindow.action, 'edit');
    const outWindow = planner.plan(editIntent({ sentAt: t.box.now - 61 * 1000 }));
    assert.equal(outWindow.action, 'unsupported');
    assert.equal(outWindow.failureCode, 'MES_WINDOW_EXPIRED');
  });
});

describe('message-edit-sync: intent validation', () => {
  const t = fakeClock();

  it('rejects malformed intents with MES_INVALID_INTENT', () => {
    expectMesError(() => planIntent(null, DEFAULT_MATRIX, t.box.now), 'MES_INVALID_INTENT');
    expectMesError(() => planIntent({}, DEFAULT_MATRIX, t.box.now), 'MES_INVALID_INTENT');
    expectMesError(
      () => planIntent(editIntent({ channel: '' }), DEFAULT_MATRIX, t.box.now),
      'MES_INVALID_INTENT',
    );
    expectMesError(
      () => planIntent(editIntent({ messageId: '' }), DEFAULT_MATRIX, t.box.now),
      'MES_INVALID_INTENT',
    );
    expectMesError(
      () => planIntent(editIntent({ sentAt: Number.NaN }), DEFAULT_MATRIX, t.box.now),
      'MES_INVALID_INTENT',
    );
    expectMesError(
      () => planIntent(editIntent({ kind: 'react' }), DEFAULT_MATRIX, t.box.now),
      'MES_INVALID_INTENT',
    );
    expectMesError(
      () => planIntent(editIntent({ newText: '' }), DEFAULT_MATRIX, t.box.now),
      'MES_INVALID_INTENT',
    );
  });

  it('submit() on a malformed intent throws MES_INVALID_INTENT and records nothing', () => {
    const planner = createMessageEditSync({ clock: t.clock });
    const before = planner.audit.length;
    expectMesError(() => planner.submit(editIntent({ kind: 'nope' }), 'agent'), 'MES_INVALID_INTENT');
    assert.equal(planner.audit.length, before);
  });
});

describe('message-edit-sync: execution', () => {
  it('happy path: planned → syncing → synced, syncer gets the op', async () => {
    const t = fakeClock();
    const calls = [];
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async (op) => {
        calls.push(op);
        return { ok: true };
      },
    });

    const submitted = planner.submit(
      editIntent({ sentAt: t.box.now - 1000 }),
      'agent',
    );
    assert.equal(submitted.state, 'planned');
    assert.equal(submitted.action, 'edit');
    assert.equal(submitted.attempts, 0);

    const synced = await planner.execute(submitted.id, 'agent');
    assert.equal(synced.state, 'synced');
    assert.equal(synced.attempts, 1);
    assert.equal(calls.length, 1);

    const op = calls[0];
    assert.equal(op.planId, submitted.id);
    assert.equal(op.action, 'edit');
    assert.equal(op.channel, 'telegram');
    assert.equal(op.messageId, 'msg-1');
    assert.equal(op.newText, 'edited text');
    assert.equal(op.actor, 'agent');

    // audit: null→planned, planned→syncing, syncing→synced
    const states = planner.audit.map((e) => e.to);
    assert.deepEqual(states, ['planned', 'syncing', 'synced']);
  });

  it('delete intent reaches the syncer without newText', async () => {
    const t = fakeClock();
    const calls = [];
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async (op) => calls.push(op),
    });
    const submitted = planner.submit(editIntent({ kind: 'delete', sentAt: t.box.now - 1000 }), 'agent');
    assert.equal(submitted.action, 'delete');
    await planner.execute(submitted.id, 'agent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'delete');
    assert.ok(!('newText' in calls[0]), 'delete op must not carry newText');
  });

  it('retract-request reaches the syncer for email delete', async () => {
    const t = fakeClock();
    const calls = [];
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async (op) => calls.push(op),
    });
    const submitted = planner.submit(
      editIntent({ channel: 'email', kind: 'delete', sentAt: t.box.now - 1000 }),
      'agent',
    );
    assert.equal(submitted.action, 'retract-request');
    const synced = await planner.execute(submitted.id, 'agent');
    assert.equal(synced.state, 'synced');
    assert.equal(calls[0].action, 'retract-request');
  });

  it('retries exactly once on transient syncer failure, then syncs', async () => {
    const t = fakeClock();
    let calls = 0;
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async () => {
        calls += 1;
        if (calls === 1) throw transientError('rate limited');
        return { ok: true };
      },
    });
    const submitted = planner.submit(editIntent({ sentAt: t.box.now - 1000 }), 'agent');
    const synced = await planner.execute(submitted.id, 'agent');
    assert.equal(synced.state, 'synced');
    assert.equal(synced.attempts, 2, 'exactly one retry');
    assert.equal(calls, 2);
  });

  it('transient failure twice → failed + MES_SYNC_FAILED', async () => {
    const t = fakeClock();
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async () => {
        throw transientError('still down');
      },
    });
    const submitted = planner.submit(editIntent({ sentAt: t.box.now - 1000 }), 'agent');
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_SYNC_FAILED');
    const rec = planner.get(submitted.id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.attempts, 2, 'no more than one retry');
    assert.ok(rec.lastError);
  });

  it('permanent failure → failed immediately with no retry', async () => {
    const t = fakeClock();
    let calls = 0;
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async () => {
        calls += 1;
        throw new Error('auth revoked');
      },
    });
    const submitted = planner.submit(editIntent({ sentAt: t.box.now - 1000 }), 'agent');
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_SYNC_FAILED');
    assert.equal(calls, 1, 'permanent errors are not retried');
    assert.equal(planner.get(submitted.id).state, 'failed');
  });

  it('custom isTransient classifier is honored', async () => {
    const t = fakeClock();
    let calls = 0;
    const planner = createMessageEditSync({
      clock: t.clock,
      isTransient: (err) => err && err.code === 'EAGAIN',
      syncer: async () => {
        calls += 1;
        const err = new Error('try again');
        err.code = 'EAGAIN';
        throw err;
      },
    });
    const submitted = planner.submit(editIntent({ sentAt: t.box.now - 1000 }), 'agent');
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_SYNC_FAILED');
    assert.equal(calls, 2, 'one retry via custom classifier');
  });

  it('fail-fast: unsupported intent throws MES_UNSUPPORTED and never calls the syncer', async () => {
    const t = fakeClock();
    let calls = 0;
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async () => {
        calls += 1;
      },
    });
    const submitted = planner.submit(
      editIntent({ channel: 'email', sentAt: t.box.now - 1000 }),
      'agent',
    );
    assert.equal(submitted.action, 'unsupported');

    const before = calls;
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_UNSUPPORTED');
    assert.equal(calls, before, 'syncer must never be called for unsupported intents');
    assert.equal(planner.get(submitted.id).state, 'unsupported');

    const last = planner.audit[planner.audit.length - 1];
    assert.equal(last.to, 'unsupported');
    assert.equal(last.detail.failureCode, 'MES_UNSUPPORTED');
  });

  it('fail-fast: window-expired intent throws MES_WINDOW_EXPIRED, syncer untouched', async () => {
    const t = fakeClock();
    let calls = 0;
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async () => {
        calls += 1;
      },
    });
    const submitted = planner.submit(
      editIntent({ sentAt: t.box.now - (48 * 60 * 60 * 1000 + 1000) }),
      'agent',
    );
    assert.equal(submitted.action, 'unsupported');
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_WINDOW_EXPIRED');
    assert.equal(calls, 0);
    assert.equal(planner.get(submitted.id).state, 'unsupported');
  });

  it('execute on unknown id → MES_NOT_FOUND', async () => {
    const planner = createMessageEditSync({ clock: fakeClock().clock });
    await expectMesErrorAsync(() => planner.execute('nope'), 'MES_NOT_FOUND');
    assert.equal(planner.get('nope'), null);
  });

  it('execute on a non-planned record → MES_INVALID_TRANSITION', async () => {
    const t = fakeClock();
    const planner = createMessageEditSync({
      clock: t.clock,
      syncer: async () => ({ ok: true }),
    });
    const submitted = planner.submit(editIntent({ sentAt: t.box.now - 1000 }), 'agent');
    await planner.execute(submitted.id, 'agent');
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_INVALID_TRANSITION');
  });

  it('execute without a syncer → MES_NO_SYNCER and record goes failed', async () => {
    const t = fakeClock();
    const planner = createMessageEditSync({ clock: t.clock });
    const submitted = planner.submit(editIntent({ sentAt: t.box.now - 1000 }), 'agent');
    await expectMesErrorAsync(() => planner.execute(submitted.id, 'agent'), 'MES_NO_SYNCER');
    assert.equal(planner.get(submitted.id).state, 'failed');
  });
});

describe('message-edit-sync: coded-error contract', () => {
  it('every thrown error is an Error with a code property', async () => {
    const t = fakeClock();
    const codes = [];
    const planner = createMessageEditSync({ clock: t.clock, syncer: async () => ({}) });

    const check = (fn) => {
      try {
        fn();
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(typeof err.code === 'string' && err.code.length > 0);
        codes.push(err.code);
        return;
      }
      assert.fail('expected a throw');
    };

    check(() => planner.submit(editIntent({ kind: 'x' }))); // MES_INVALID_INTENT
    const unsupported = planner.submit(editIntent({ channel: 'email', sentAt: t.box.now - 1 }));
    await planner.execute(unsupported.id).catch((err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'MES_UNSUPPORTED');
      codes.push(err.code);
    });
    await planner.execute('missing').catch((err) => codes.push(err.code)); // MES_NOT_FOUND
    assert.deepEqual(codes, ['MES_INVALID_INTENT', 'MES_UNSUPPORTED', 'MES_NOT_FOUND']);
  });
});
