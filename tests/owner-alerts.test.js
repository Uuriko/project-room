/**
 * owner-alerts.test.js — tests for the owner-alert dispatcher.
 *
 * Covers: raise validation, dispatch happy path, retry-then-fail, retry-then-
 * success backoff, acknowledge/resolve, dedupe, escalation re-notify, list
 * filters, snapshot/restore (+ corruption), storage hydration, subscribers,
 * and the coded-error contract. All IO is faked: fake clock, fake notifier,
 * fake sleep/backoff, in-memory storage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOwnerAlertDispatcher,
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_ESCALATION_AFTER_MS,
  MAX_DISPATCH_ATTEMPTS,
  OWNER_ALERTS_SCHEMA_VERSION,
  SEVERITIES,
  STATES,
} from '../src/owner-alerts.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
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

/** Fake notifier: records calls, fails on demand. */
function fakeNotifier({ failTimes = 0, failWith = new Error('channel down') } = {}) {
  const calls = [];
  let failuresLeft = failTimes;
  return {
    calls,
    notify: async (alert, opts) => {
      calls.push({ alert, opts: opts ?? null });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw failWith;
      }
      return { delivered: true };
    },
  };
}

/** Fake sleep/backoff pair: records requested delays, never actually waits. */
function fakeSleepBackoff() {
  const sleeps = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    backoff: (attempt) => attempt * 250,
  };
}

/** In-memory storage adapter: { load(), save() } with visibility. */
function fakeStorage(initial = null, { throwOnSave = false } = {}) {
  const box = { saved: null, saves: 0, data: initial };
  return {
    box,
    storage: {
      load: () => box.data,
      save: (snap) => {
        if (throwOnSave) throw new Error('disk full');
        box.saves += 1;
        box.saved = snap;
        box.data = snap; // a later dispatcher hydrates from what was saved
      },
    },
  };
}

const ALERT = () => ({
  severity: 'warning',
  title: 'LP depth below target',
  body: 'Raydium LP dropped under the $50K watch line.',
  source: 'mcap-watch',
});

function expectOAError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

async function expectOAErrorAsync(fn, code) {
  await assert.rejects(fn(), (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('owner-alerts', () => {
  it('raise validates severity, title, body, and source', () => {
    const d = createOwnerAlertDispatcher();
    expectOAError(() => d.raise({ ...ALERT(), severity: 'meh' }), 'OA_INVALID_ALERT');
    expectOAError(() => d.raise({ ...ALERT(), title: '' }), 'OA_INVALID_ALERT');
    expectOAError(() => d.raise({ ...ALERT(), title: '   ' }), 'OA_INVALID_ALERT');
    expectOAError(() => d.raise({ ...ALERT(), body: '' }), 'OA_INVALID_ALERT');
    expectOAError(() => d.raise({ ...ALERT(), source: '' }), 'OA_INVALID_ALERT');
    expectOAError(() => d.raise(), 'OA_INVALID_ALERT');
    assert.equal(d.list().length, 0, 'no alert is created on validation failure');

    const raised = d.raise(ALERT(), 'agent');
    assert.equal(raised.state, 'pending');
    assert.equal(raised.severity, 'warning');
    assert.deepEqual(raised.attempts, []);
    assert.ok(raised.id);
    assert.ok(typeof raised.createdAt === 'number' && raised.createdAt > 0);
    const entry = d.audit.at(-1);
    assert.equal(entry.from, null);
    assert.equal(entry.to, 'pending');
  });

  it('dispatch happy path notifies, records the attempt, and marks sent', async () => {
    const notifier = fakeNotifier();
    const events = [];
    const d = createOwnerAlertDispatcher({ notifier });
    d.subscribe((e) => events.push(e));

    const raised = d.raise(ALERT(), 'agent');
    const sent = await d.dispatch(raised.id, 'agent');
    assert.equal(sent.state, 'sent');
    assert.ok(sent.sentAt >= raised.createdAt);

    assert.equal(notifier.calls.length, 1);
    assert.equal(notifier.calls[0].alert.id, raised.id);
    assert.equal(notifier.calls[0].opts, null, 'plain dispatch carries no opts');

    const stored = d.get(raised.id);
    assert.equal(stored.attempts.length, 1);
    assert.equal(stored.attempts[0].kind, 'dispatch');
    assert.equal(stored.attempts[0].attempt, 1);
    assert.equal(stored.attempts[0].ok, true);

    assert.deepEqual(events.map((e) => e.type), ['raised', 'dispatched']);
    assert.ok(events[1].alert.id === raised.id && events[1].at >= 0);
  });

  it('dispatch retries with injected backoff and succeeds on the 2nd attempt', async () => {
    const notifier = fakeNotifier({ failTimes: 1 });
    const { sleep, sleeps, backoff } = fakeSleepBackoff();
    const d = createOwnerAlertDispatcher({ notifier, sleep, backoff });

    const raised = d.raise(ALERT(), 'agent');
    const sent = await d.dispatch(raised.id, 'agent');
    assert.equal(sent.state, 'sent');
    assert.equal(notifier.calls.length, 2);
    assert.deepEqual(sleeps, [250], 'backoff(1) is awaited between attempts');

    const stored = d.get(raised.id);
    assert.equal(stored.attempts.length, 2);
    assert.equal(stored.attempts[0].ok, false);
    assert.equal(stored.attempts[0].error, 'channel down');
    assert.equal(stored.attempts[1].ok, true);
  });

  it('dispatch failing all retries throws OA_DELIVERY_FAILED and stays pending', async () => {
    const notifier = fakeNotifier({ failTimes: 99 });
    const { sleep, sleeps, backoff } = fakeSleepBackoff();
    const events = [];
    const d = createOwnerAlertDispatcher({ notifier, sleep, backoff });
    d.subscribe((e) => events.push(e.type));

    const raised = d.raise(ALERT(), 'agent');
    await expectOAErrorAsync(() => d.dispatch(raised.id, 'agent'), 'OA_DELIVERY_FAILED');

    assert.equal(notifier.calls.length, MAX_DISPATCH_ATTEMPTS);
    assert.deepEqual(sleeps, [250, 500], 'backoff awaited between attempts, not after the last');
    assert.equal(d.get(raised.id).state, 'pending', 'failed delivery keeps the alert pending');

    const stored = d.get(raised.id);
    assert.equal(stored.attempts.length, MAX_DISPATCH_ATTEMPTS);
    assert.ok(stored.attempts.every((a) => a.ok === false));
    assert.ok(stored.attempts.every((a) => a.error === 'channel down'));

    assert.deepEqual(events, ['raised', 'dispatch-failed']);

    // Retrying again later is allowed while still pending.
    await expectOAErrorAsync(() => d.dispatch(raised.id, 'agent'), 'OA_DELIVERY_FAILED');
    assert.equal(d.get(raised.id).attempts.length, MAX_DISPATCH_ATTEMPTS * 2);
  });

  it('dispatch without an injected notifier throws OA_NOTIFIER_MISSING', async () => {
    const d = createOwnerAlertDispatcher();
    const raised = d.raise(ALERT(), 'agent');
    await expectOAErrorAsync(() => d.dispatch(raised.id, 'agent'), 'OA_NOTIFIER_MISSING');
    assert.equal(d.get(raised.id).state, 'pending');
  });

  it('dispatch is only valid from pending', async () => {
    const notifier = fakeNotifier();
    const d = createOwnerAlertDispatcher({ notifier });
    const raised = d.raise(ALERT(), 'agent');
    await d.dispatch(raised.id, 'agent');
    await expectOAErrorAsync(() => d.dispatch(raised.id, 'agent'), 'OA_INVALID_STATE');
    d.acknowledge(raised.id, 'john');
    await expectOAErrorAsync(() => d.dispatch(raised.id, 'agent'), 'OA_INVALID_STATE');
    assert.equal(notifier.calls.length, 1, 'no extra notification went out');
  });

  it('acknowledge and resolve record who/when and move states', () => {
    const { clock, advance } = fakeClock();
    const d = createOwnerAlertDispatcher({ clock });
    const raised = d.raise(ALERT(), 'agent');

    advance(1_000);
    const acked = d.acknowledge(raised.id, 'john');
    assert.equal(acked.state, 'acknowledged');
    assert.equal(acked.acknowledgedBy, 'john');
    assert.equal(acked.acknowledgedAt, clock());

    // Double acknowledge is invalid.
    expectOAError(() => d.acknowledge(raised.id, 'john'), 'OA_INVALID_STATE');

    advance(2_000);
    const resolved = d.resolve(raised.id, 'john', 'LP refilled');
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.resolvedBy, 'john');
    assert.equal(resolved.resolveNote, 'LP refilled');
    assert.equal(resolved.resolvedAt, clock());

    // Resolving twice is invalid.
    expectOAError(() => d.resolve(raised.id, 'john'), 'OA_INVALID_STATE');
    expectOAError(() => d.acknowledge(raised.id, 'john'), 'OA_INVALID_STATE');
  });

  it('acknowledge from sent works; resolve skips acknowledge when needed', () => {
    const notifier = fakeNotifier();
    const d = createOwnerAlertDispatcher({ notifier });
    const a = d.raise(ALERT(), 'agent');
    // Acknowledge straight from pending is allowed.
    d.acknowledge(a.id, 'john');
    assert.equal(d.get(a.id).state, 'acknowledged');

    const b = d.raise({ ...ALERT(), title: 'Second' }, 'agent');
    return d.dispatch(b.id, 'agent').then(() => {
      d.resolve(b.id, 'john'); // sent → resolved, no note
      const got = d.get(b.id);
      assert.equal(got.state, 'resolved');
      assert.equal(got.resolveNote, '');

      // acknowledge/resolve require a non-empty actor.
      const c = d.raise({ ...ALERT(), title: 'Third' }, 'agent');
      expectOAError(() => d.acknowledge(c.id, ''), 'OA_INVALID_ALERT');
      expectOAError(() => d.resolve(c.id, '  '), 'OA_INVALID_ALERT');
      assert.equal(d.get(c.id).state, 'pending', 'failed validation leaves the alert untouched');
    });
  });

  it('unknown alert ids throw OA_NOT_FOUND', async () => {
    const d = createOwnerAlertDispatcher({ notifier: fakeNotifier() });
    expectOAError(() => d.acknowledge('nope', 'john'), 'OA_NOT_FOUND');
    expectOAError(() => d.resolve('nope', 'john'), 'OA_NOT_FOUND');
    await expectOAErrorAsync(() => d.dispatch('nope', 'agent'), 'OA_NOT_FOUND');
    assert.equal(d.get('nope'), null);
  });

  it('dedupe returns the existing pending alert for the same source+title', () => {
    const { clock, advance } = fakeClock();
    const events = [];
    const d = createOwnerAlertDispatcher({ clock });
    d.subscribe((e) => events.push(e.type));

    const first = d.raise(ALERT(), 'agent');
    const second = d.raise(ALERT(), 'agent');
    assert.equal(second.id, first.id, 'duplicate returns the existing alert');
    assert.equal(d.list().length, 1);

    const dedupeEntry = d.audit.find((e) => e.detail && e.detail.deduped === true);
    assert.ok(dedupeEntry, 'the dedupe is recorded in the audit log');
    assert.equal(dedupeEntry.detail.alertId, first.id);
    assert.deepEqual(events, ['raised', 'deduped']);

    // A different title is a new alert; a different source is a new alert.
    d.raise({ ...ALERT(), title: 'Different title' }, 'agent');
    d.raise({ ...ALERT(), source: 'other-watch' }, 'agent');
    assert.equal(d.list().length, 3);

    // Outside the dedupe window a duplicate is a new alert.
    advance(DEFAULT_DEDUPE_WINDOW_MS + 1);
    const again = d.raise(ALERT(), 'agent');
    assert.notEqual(again.id, first.id);
    assert.equal(d.list().length, 4);
  });

  it('dedupe only matches pending alerts', () => {
    const d = createOwnerAlertDispatcher();
    const first = d.raise(ALERT(), 'agent');
    d.resolve(first.id, 'john', 'done');
    const second = d.raise(ALERT(), 'agent');
    assert.notEqual(second.id, first.id, 'resolved alerts do not dedupe');
    assert.equal(d.list().length, 2);
  });

  it('respects a custom dedupeWindowMs', () => {
    const { clock, advance } = fakeClock();
    const d = createOwnerAlertDispatcher({ clock, dedupeWindowMs: 1_000 });
    const first = d.raise(ALERT(), 'agent');
    advance(999);
    assert.equal(d.raise(ALERT(), 'agent').id, first.id);
    advance(2);
    assert.notEqual(d.raise(ALERT(), 'agent').id, first.id);
  });

  it('escalation re-notifies stale critical alerts with the escalated flag', async () => {
    const { clock, advance } = fakeClock();
    const notifier = fakeNotifier();
    const events = [];
    const d = createOwnerAlertDispatcher({ clock, notifier });
    d.subscribe((e) => events.push(e.type));

    const critical = d.raise({ ...ALERT(), severity: 'critical', title: 'C' }, 'agent');
    const warning = d.raise({ ...ALERT(), severity: 'warning', title: 'W' }, 'agent');
    const criticalFresh = d.raise({ ...ALERT(), severity: 'critical', title: 'C2' }, 'agent');
    await d.dispatch(criticalFresh.id, 'agent'); // sent, acknowledged → not escalated
    d.acknowledge(criticalFresh.id, 'john');

    advance(DEFAULT_ESCALATION_AFTER_MS + 1);

    const escalated = await d.sweep('system');
    assert.deepEqual(escalated, [critical.id], 'only the stale unacked critical re-notifies');

    // The re-notify carried the escalated flag; the stale pending alert moved to sent.
    assert.equal(notifier.calls.length, 2);
    const renotify = notifier.calls[1];
    assert.equal(renotify.alert.id, critical.id);
    assert.deepEqual(renotify.opts, { escalated: true });

    const got = d.get(critical.id);
    assert.equal(got.state, 'sent');
    assert.equal(got.escalatedAt, clock());
    assert.ok(got.attempts.some((a) => a.kind === 'escalation' && a.ok));

    const entry = d.audit.find((e) => e.detail && e.detail.escalated === true);
    assert.ok(entry, 'escalation lands in the audit log');
    assert.equal(entry.detail.alertId, critical.id);
    assert.ok(events.includes('escalated'));

    assert.equal(d.get(warning.id).state, 'pending', 'warnings never escalate');
    assert.equal(d.get(criticalFresh.id).escalatedAt, null, 'acknowledged alerts never escalate');

    // A second sweep does not re-notify an already-escalated alert.
    const second = await d.sweep('system');
    assert.deepEqual(second, []);
    assert.equal(notifier.calls.length, 2);
  });

  it('escalation of an already-sent critical alert keeps it sent and audits it', async () => {
    const { clock, advance } = fakeClock();
    const notifier = fakeNotifier();
    const d = createOwnerAlertDispatcher({ clock, notifier });

    const critical = d.raise({ ...ALERT(), severity: 'critical' }, 'agent');
    await d.dispatch(critical.id, 'agent');
    advance(DEFAULT_ESCALATION_AFTER_MS + 1);
    const escalated = await d.sweep('system');
    assert.deepEqual(escalated, [critical.id]);
    const got = d.get(critical.id);
    assert.equal(got.state, 'sent');
    assert.equal(got.escalatedAt, clock());
    assert.deepEqual(notifier.calls[1].opts, { escalated: true });
  });

  it('escalation re-notify failure records it and throws OA_DELIVERY_FAILED', async () => {
    const { clock, advance } = fakeClock();
    const notifier = fakeNotifier({ failTimes: 99 });
    const d = createOwnerAlertDispatcher({ clock, notifier });

    const critical = d.raise({ ...ALERT(), severity: 'critical' }, 'agent');
    advance(DEFAULT_ESCALATION_AFTER_MS + 1);
    await expectOAErrorAsync(() => d.sweep('system'), 'OA_DELIVERY_FAILED');

    const got = d.get(critical.id);
    assert.equal(got.state, 'pending', 'failed escalation keeps the alert pending');
    assert.equal(got.escalatedAt, null);
    assert.ok(got.attempts.some((a) => a.kind === 'escalation' && a.ok === false));
  });

  it('sweep without a notifier throws OA_NOTIFIER_MISSING', async () => {
    const d = createOwnerAlertDispatcher();
    await expectOAErrorAsync(() => d.sweep('system'), 'OA_NOTIFIER_MISSING');
  });

  it('list filters by state and severity', async () => {
    const notifier = fakeNotifier();
    const d = createOwnerAlertDispatcher({ notifier });
    const info = d.raise({ ...ALERT(), severity: 'info', title: 'I' }, 'agent');
    const crit = d.raise({ ...ALERT(), severity: 'critical', title: 'C' }, 'agent');
    const warn = d.raise({ ...ALERT(), severity: 'warning', title: 'W' }, 'agent');
    await d.dispatch(info.id, 'agent');
    d.acknowledge(crit.id, 'john');

    assert.equal(d.list().length, 3);
    assert.deepEqual(d.list({ state: 'sent' }).map((a) => a.id), [info.id]);
    assert.deepEqual(d.list({ state: 'pending' }).map((a) => a.id), [warn.id]);
    assert.deepEqual(d.list({ severity: 'critical' }).map((a) => a.id), [crit.id]);
    assert.deepEqual(
      d.list({ state: 'acknowledged', severity: 'critical' }).map((a) => a.id),
      [crit.id],
    );
    assert.deepEqual(d.list({ state: 'resolved' }), []);
  });

  it('snapshot/restore round-trips state with the schema version', async () => {
    const notifier = fakeNotifier();
    const d1 = createOwnerAlertDispatcher({ notifier });
    const a = d1.raise(ALERT(), 'agent');
    await d1.dispatch(a.id, 'agent');
    d1.acknowledge(a.id, 'john');
    const b = d1.raise({ ...ALERT(), severity: 'critical', title: 'B' }, 'agent');

    const snap = d1.snapshot();
    assert.equal(snap.version, OWNER_ALERTS_SCHEMA_VERSION);
    assert.equal(snap.alerts.length, 2);
    assert.ok(snap.exportedAt >= 0);

    const d2 = createOwnerAlertDispatcher({ notifier });
    const restored = d2.restore(snap);
    assert.equal(restored, 2);
    assert.equal(d2.get(a.id).state, 'acknowledged');
    assert.equal(d2.get(a.id).acknowledgedBy, 'john');
    assert.equal(d2.get(b.id).state, 'pending');
    assert.equal(d2.audit.length, d1.audit.length, 'audit travels with the snapshot');
  });

  it('restore rejects corrupt payloads with OA_SNAPSHOT_CORRUPT', () => {
    const d = createOwnerAlertDispatcher();
    const valid = d.snapshot();
    expectOAError(() => d.restore({ ...valid, version: 999 }), 'OA_SNAPSHOT_CORRUPT');
    expectOAError(() => d.restore({ version: OWNER_ALERTS_SCHEMA_VERSION }), 'OA_SNAPSHOT_CORRUPT');
    expectOAError(() => d.restore({ ...valid, alerts: 'nope' }), 'OA_SNAPSHOT_CORRUPT');
    expectOAError(() => d.restore(null), 'OA_SNAPSHOT_CORRUPT');
    expectOAError(
      () => d.restore({ ...valid, alerts: [{ id: 'x' }] }),
      'OA_SNAPSHOT_CORRUPT',
    );
    expectOAError(
      () =>
        d.restore({
          ...valid,
          alerts: [
            {
              id: 'x',
              severity: 'info',
              title: 't',
              body: 'b',
              source: 's',
              createdAt: 1,
              state: 'bogus-state',
              attempts: [],
            },
          ],
        }),
      'OA_SNAPSHOT_CORRUPT',
    );
    expectOAError(
      () =>
        d.restore({
          ...valid,
          alerts: [
            {
              id: 'x',
              severity: 'nonsense',
              title: 't',
              body: 'b',
              source: 's',
              createdAt: 1,
              state: 'pending',
              attempts: [],
            },
          ],
        }),
      'OA_SNAPSHOT_CORRUPT',
    );
  });

  it('storage hydrates on creation and saves after every mutation', async () => {
    const notifier = fakeNotifier();
    const { storage, box } = fakeStorage();
    const d1 = createOwnerAlertDispatcher({ storage, notifier });
    const a = d1.raise(ALERT(), 'agent');
    assert.equal(box.saves, 1, 'raise persists');
    await d1.dispatch(a.id, 'agent');
    assert.equal(box.saves, 2, 'dispatch persists');
    d1.resolve(a.id, 'john');
    assert.equal(box.saves, 3, 'resolve persists');
    assert.equal(box.saved.version, OWNER_ALERTS_SCHEMA_VERSION);
    assert.equal(box.saved.alerts.length, 1);

    // A new dispatcher hydrates from the stored snapshot.
    const d2 = createOwnerAlertDispatcher({ storage, notifier });
    assert.equal(d2.get(a.id).state, 'resolved');
    assert.equal(d2.get(a.id).resolvedBy, 'john');

    // Corrupt storage fails loudly on creation.
    const bad = fakeStorage({ version: 123, alerts: [] });
    expectOAError(() => createOwnerAlertDispatcher({ storage: bad.storage }), 'OA_SNAPSHOT_CORRUPT');

    // Storage failures are coded, never silent.
    const failing = fakeStorage(null, { throwOnSave: true });
    const d3 = createOwnerAlertDispatcher({ storage: failing.storage, notifier });
    expectOAError(() => d3.raise(ALERT(), 'agent'), 'OA_STORAGE_ERROR');
  });

  it('subscribers get every event and can unsubscribe; bad listeners throw', () => {
    const d = createOwnerAlertDispatcher();
    const seen = [];
    const unsubscribe = d.subscribe((e) => seen.push(e.type));
    expectOAError(() => d.subscribe('not-a-function'), 'OA_INVALID_ALERT');

    const a = d.raise(ALERT(), 'agent');
    d.acknowledge(a.id, 'john');
    d.resolve(a.id, 'john');
    assert.deepEqual(seen, ['raised', 'acknowledged', 'resolved']);

    unsubscribe();
    d.raise({ ...ALERT(), title: 'Unseen' }, 'agent');
    assert.deepEqual(seen, ['raised', 'acknowledged', 'resolved']);
  });

  it('dispatch notifier payloads are frozen snapshots (mutations do not leak)', async () => {
    const notifier = fakeNotifier();
    const d = createOwnerAlertDispatcher({ notifier });
    const raised = d.raise(ALERT(), 'agent');
    await d.dispatch(raised.id, 'agent');
    const payload = notifier.calls[0].alert;
    assert.ok(Object.isFrozen(payload), 'notify receives a frozen snapshot');
    assert.throws(() => {
      payload.state = 'resolved';
    });
    assert.equal(d.get(raised.id).state, 'sent');
  });

  it('exports cover the full state graph and defaults', () => {
    assert.deepEqual([...STATES].sort(), ['acknowledged', 'pending', 'resolved', 'sent']);
    assert.deepEqual([...SEVERITIES].sort(), ['critical', 'info', 'warning']);
    assert.equal(OWNER_ALERTS_SCHEMA_VERSION, 1);
    assert.equal(DEFAULT_ESCALATION_AFTER_MS, 15 * 60 * 1000);
    assert.equal(DEFAULT_DEDUPE_WINDOW_MS, 10 * 60 * 1000);
    const d = createOwnerAlertDispatcher();
    assert.equal(d.schemaVersion, OWNER_ALERTS_SCHEMA_VERSION);
    assert.equal(d.escalationAfterMs, DEFAULT_ESCALATION_AFTER_MS);
    assert.equal(d.dedupeWindowMs, DEFAULT_DEDUPE_WINDOW_MS);
    assert.equal(d.get('missing'), null);
  });
});
