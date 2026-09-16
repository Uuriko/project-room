/**
 * digest-scheduler.test.js — tests for the digest-mode subscription scheduler.
 *
 * Covers: subscribe/unsubscribe/get/list, cadence math (immediate/hourly/
 * daily/weekly), quiet-hours skip (daytime + overnight windows), due
 * detection, markSent re-anchoring cadence, collect() batching per
 * subscription, pause/resume, invalid schedule rejection, snapshot/restore,
 * corrupt-snapshot rejection, write-through storage, and the coded-error
 * contract. Fake clock + in-memory storage fake; no real timers, no network.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDigestScheduler, CADENCES, SCHEMA_VERSION } from '../src/digest-scheduler.mjs';

const H = 60 * 60 * 1000;
const D = 24 * H;

/** Controllable clock: { box, clock(), advance(ms) }. */
function fakeClock(start = 1_700_000_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** In-memory storage fake: { store, save(), load() }. */
function fakeStorage() {
  const store = { saved: null, saves: 0 };
  return {
    store,
    save: (obj) => {
      store.saved = obj;
      store.saves += 1;
    },
    load: () => store.saved,
  };
}

function expectDsError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

const SUB = (over = {}) => ({
  userId: 'user-1',
  channels: ['email'],
  cadence: 'daily',
  ...over,
});

describe('digest-scheduler', () => {
  describe('subscribe / get / list / unsubscribe', () => {
    it('subscribes with defaults and returns a frozen snapshot', () => {
      const s = createDigestScheduler({ clock: fakeClock().clock });
      const sub = s.subscribe(SUB());
      assert.equal(sub.userId, 'user-1');
      assert.deepEqual(sub.channels, ['email']);
      assert.equal(sub.cadence, 'daily');
      assert.equal(sub.quietHours, null);
      assert.equal(sub.lastSentAt, null);
      assert.equal(sub.paused, false);
      assert.ok(sub.id);
      assert.ok(sub.createdAt > 0);
      assert.ok(Object.isFrozen(sub));

      assert.deepEqual(s.get(sub.id), sub);
      assert.deepEqual(s.list().map((x) => x.id), [sub.id]);
    });

    it('get returns null for unknown ids; unsubscribe throws DS_NOT_FOUND', () => {
      const s = createDigestScheduler();
      assert.equal(s.get('nope'), null);
      expectDsError(() => s.unsubscribe('nope'), 'DS_NOT_FOUND');
    });

    it('unsubscribe removes the subscription and returns its final snapshot', () => {
      const s = createDigestScheduler();
      const a = s.subscribe(SUB());
      const b = s.subscribe(SUB({ userId: 'user-2' }));
      const removed = s.unsubscribe(a.id);
      assert.equal(removed.id, a.id);
      assert.equal(s.get(a.id), null);
      assert.deepEqual(s.list().map((x) => x.id), [b.id]);
    });

    it('rejects an invalid cadence with DS_INVALID_SCHEDULE', () => {
      const s = createDigestScheduler();
      expectDsError(() => s.subscribe(SUB({ cadence: 'minutely' })), 'DS_INVALID_SCHEDULE');
      expectDsError(() => s.subscribe(SUB({ cadence: '' })), 'DS_INVALID_SCHEDULE');
    });

    it('rejects bad subscription fields with coded errors', () => {
      const s = createDigestScheduler();
      expectDsError(() => s.subscribe(SUB({ userId: '' })), 'DS_INVALID_ARGUMENT');
      expectDsError(() => s.subscribe(SUB({ channels: [] })), 'DS_INVALID_ARGUMENT');
      expectDsError(() => s.subscribe(SUB({ channels: 'email' })), 'DS_INVALID_ARGUMENT');
      expectDsError(() => s.subscribe(SUB({ quietHours: { start: '25:00', end: '07:00' } })), 'DS_INVALID_SCHEDULE');
      expectDsError(() => s.subscribe(SUB({ quietHours: { start: '22:00', end: 'nope' } })), 'DS_INVALID_SCHEDULE');
      expectDsError(
        () => s.subscribe(SUB({ quietHours: { start: '22:00', end: '07:00', tz: 'Mars/Olympus' } })),
        'DS_INVALID_SCHEDULE',
      );
    });
  });

  describe('cadence math', () => {
    it('immediate is due right now', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(SUB({ cadence: 'immediate' }));
      assert.equal(s.nextDue(sub.id, fc.clock()), fc.clock());
    });

    it('hourly anchors on lastSentAt', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(SUB({ cadence: 'hourly' }));
      // Never sent: due now.
      assert.equal(s.nextDue(sub.id, fc.clock()), fc.clock());
      s.markSent(sub.id, fc.clock());
      assert.equal(s.nextDue(sub.id, fc.clock()), fc.clock() + H);
      fc.advance(30 * 60 * 1000);
      assert.equal(s.nextDue(sub.id, fc.clock()), fc.box.now + 30 * 60 * 1000);
    });

    it('daily and weekly cadences', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const d = s.subscribe(SUB({ cadence: 'daily' }));
      const w = s.subscribe(SUB({ cadence: 'weekly' }));
      const t0 = fc.clock();
      s.markSent(d.id, t0);
      s.markSent(w.id, t0);
      assert.equal(s.nextDue(d.id, t0), t0 + D);
      assert.equal(s.nextDue(w.id, t0), t0 + 7 * D);
      fc.advance(D);
      assert.equal(s.nextDue(d.id, fc.clock()), fc.clock()); // daily due now
      assert.ok(s.nextDue(w.id, fc.clock()) > fc.clock()); // weekly still pending
    });

    it('CADENCES is frozen and lists all four cadences', () => {
      assert.deepEqual([...CADENCES], ['immediate', 'hourly', 'daily', 'weekly']);
      assert.ok(Object.isFrozen(CADENCES));
    });
  });

  describe('quiet hours', () => {
    // Anchor the fake clock at a known UTC midnight to make windows exact.
    const MIDNIGHT = Date.UTC(2026, 8, 16); // 2026-09-16T00:00:00Z

    it('skips a daytime quiet window to its end', () => {
      const fc = fakeClock(MIDNIGHT);
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(
        SUB({ cadence: 'immediate', quietHours: { start: '09:00', end: '17:00' } }),
      );
      fc.advance(12 * H); // 12:00 UTC — inside quiet hours
      assert.equal(s.nextDue(sub.id, fc.clock()), MIDNIGHT + 17 * H);
    });

    it('does not move a due time outside the quiet window', () => {
      const fc = fakeClock(MIDNIGHT);
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(
        SUB({ cadence: 'immediate', quietHours: { start: '09:00', end: '17:00' } }),
      );
      fc.advance(18 * H); // 18:00 UTC — after quiet hours
      assert.equal(s.nextDue(sub.id, fc.clock()), fc.clock());
    });

    it('skips an overnight window (22:00–07:00) after midnight', () => {
      const fc = fakeClock(MIDNIGHT);
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(
        SUB({ cadence: 'immediate', quietHours: { start: '22:00', end: '07:00' } }),
      );
      fc.advance(2 * H); // 02:00 UTC — inside the overnight window
      assert.equal(s.nextDue(sub.id, fc.clock()), MIDNIGHT + 7 * H);
      fc.advance(20 * H); // 22:00 UTC — start of the window
      assert.equal(s.nextDue(sub.id, fc.clock()), MIDNIGHT + D + 7 * H);
    });

    it('combines cadence and quiet hours: due pushed past the window', () => {
      const fc = fakeClock(MIDNIGHT);
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(
        SUB({ cadence: 'hourly', quietHours: { start: '09:00', end: '10:00' } }),
      );
      s.markSent(sub.id, MIDNIGHT + 8 * H); // sent 08:00
      // Cadence says 09:00 — inside quiet hours → pushed to 10:00.
      assert.equal(s.nextDue(sub.id, MIDNIGHT + 8 * H), MIDNIGHT + 10 * H);
    });

    it('start === end disables quiet hours', () => {
      const fc = fakeClock(MIDNIGHT + 12 * H);
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(
        SUB({ cadence: 'immediate', quietHours: { start: '12:00', end: '12:00' } }),
      );
      assert.equal(sub.quietHours, null);
      assert.equal(s.nextDue(sub.id, fc.clock()), fc.clock());
    });
  });

  describe('dueSubscriptions + markSent', () => {
    it('reports due subscriptions and markSent resets the cadence', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const hourly = s.subscribe(SUB({ cadence: 'hourly' }));
      const weekly = s.subscribe(SUB({ cadence: 'weekly' }));

      // Fresh subscriptions (never sent) are due immediately.
      assert.deepEqual(
        s.dueSubscriptions(fc.clock()).map((x) => x.id),
        [hourly.id, weekly.id],
      );

      const t0 = fc.clock();
      s.markSent(hourly.id, t0);
      s.markSent(weekly.id, t0);
      assert.deepEqual(s.dueSubscriptions(t0).map((x) => x.id), []);

      fc.advance(H + 1);
      assert.deepEqual(s.dueSubscriptions(fc.clock()).map((x) => x.id), [hourly.id]);

      // markSent re-anchors: not due again until another hour passes.
      s.markSent(hourly.id, fc.clock());
      assert.deepEqual(s.dueSubscriptions(fc.clock()).map((x) => x.id), []);
    });

    it('markSent rejects bad times and unknown ids with coded errors', () => {
      const s = createDigestScheduler();
      const sub = s.subscribe(SUB());
      expectDsError(() => s.markSent('nope'), 'DS_NOT_FOUND');
      expectDsError(() => s.markSent(sub.id, Number.NaN), 'DS_INVALID_ARGUMENT');
    });
  });

  describe('collect() batching', () => {
    it('groups items per subscription into one payload each', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const a = s.subscribe(SUB({ userId: 'u-a' }));
      const b = s.subscribe(SUB({ userId: 'u-b' }));
      const t0 = fc.clock();
      s.markSent(a.id, t0 - 2 * H);

      const payloads = s.collect(
        [
          { subscriptionId: b.id, at: t0 - 10, kind: 'mention' },
          { subscriptionId: a.id, at: t0 - 30, kind: 'reply' },
          { subscriptionId: a.id, at: t0 - 20, kind: 'like' },
          { subscriptionId: a.id, at: t0 - 25, kind: 'share' },
        ],
        t0,
      );
      assert.equal(payloads.length, 2);
      const pa = payloads.find((p) => p.subscriptionId === a.id);
      const pb = payloads.find((p) => p.subscriptionId === b.id);
      assert.deepEqual(pa.items.map((i) => i.kind), ['reply', 'share', 'like']); // sorted by at
      assert.equal(pa.windowStart, t0 - 2 * H);
      assert.equal(pa.windowEnd, t0);
      assert.equal(pb.items.length, 1);
      assert.equal(pb.windowStart, 0); // never sent
      assert.ok(Object.isFrozen(pa));
      assert.ok(Object.isFrozen(pa.items));
    });

    it('returns an empty frozen array when there are no items', () => {
      const s = createDigestScheduler();
      const out = s.collect([]);
      assert.deepEqual(out, []);
      assert.ok(Object.isFrozen(out));
    });

    it('rejects malformed items and unknown subscriptions', () => {
      const s = createDigestScheduler();
      const sub = s.subscribe(SUB());
      expectDsError(() => s.collect('nope'), 'DS_INVALID_ARGUMENT');
      expectDsError(() => s.collect([null]), 'DS_INVALID_ITEM');
      expectDsError(() => s.collect([{ at: 1 }]), 'DS_INVALID_ITEM');
      expectDsError(() => s.collect([{ subscriptionId: sub.id }]), 'DS_INVALID_ITEM');
      expectDsError(() => s.collect([{ subscriptionId: 'ghost', at: 1 }]), 'DS_NOT_FOUND');
    });
  });

  describe('pause / resume', () => {
    it('paused subscriptions are never due; resume restores them', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const sub = s.subscribe(SUB({ cadence: 'immediate' }));
      assert.deepEqual(s.dueSubscriptions(fc.clock()).map((x) => x.id), [sub.id]);

      const paused = s.pause(sub.id);
      assert.equal(paused.paused, true);
      assert.deepEqual(s.dueSubscriptions(fc.clock()), []);
      assert.equal(s.nextDue(sub.id, fc.clock()), null);

      const resumed = s.resume(sub.id);
      assert.equal(resumed.paused, false);
      assert.deepEqual(s.dueSubscriptions(fc.clock()).map((x) => x.id), [sub.id]);
    });

    it('pause/resume on unknown ids throw DS_NOT_FOUND', () => {
      const s = createDigestScheduler();
      expectDsError(() => s.pause('nope'), 'DS_NOT_FOUND');
      expectDsError(() => s.resume('nope'), 'DS_NOT_FOUND');
    });
  });

  describe('snapshot / restore', () => {
    it('round-trips state with schema version', () => {
      const fc = fakeClock();
      const s = createDigestScheduler({ clock: fc.clock });
      const a = s.subscribe(SUB({ cadence: 'hourly', quietHours: { start: '22:00', end: '07:00' } }));
      s.markSent(a.id, fc.clock());
      s.pause(a.id);

      const snap = s.snapshot();
      assert.equal(snap.schemaVersion, SCHEMA_VERSION);
      assert.equal(snap.subscriptions.length, 1);
      assert.ok(Object.isFrozen(snap));

      const s2 = createDigestScheduler();
      const restored = s2.restore(snap);
      assert.equal(restored.subscriptions.length, 1);
      assert.deepEqual(s2.get(a.id), s.get(a.id));
    });

    it('restore validates and leaves state untouched on corruption', () => {
      const s = createDigestScheduler();
      const keep = s.subscribe(SUB());
      const before = s.snapshot();

      expectDsError(() => s.restore(null), 'DS_CORRUPT_SNAPSHOT');
      expectDsError(() => s.restore({}), 'DS_CORRUPT_SNAPSHOT');
      expectDsError(() => s.restore({ schemaVersion: 999, subscriptions: [] }), 'DS_CORRUPT_SNAPSHOT');
      expectDsError(
        () => s.restore({ schemaVersion: SCHEMA_VERSION, subscriptions: 'nope' }),
        'DS_CORRUPT_SNAPSHOT',
      );
      expectDsError(
        () =>
          s.restore({
            schemaVersion: SCHEMA_VERSION,
            subscriptions: [{ ...before.subscriptions[0], cadence: 'minutely' }],
          }),
        'DS_CORRUPT_SNAPSHOT',
      );
      expectDsError(
        () =>
          s.restore({
            schemaVersion: SCHEMA_VERSION,
            subscriptions: [before.subscriptions[0], before.subscriptions[0]],
          }),
        'DS_CORRUPT_SNAPSHOT',
      );

      // State untouched by the failed restores.
      assert.deepEqual(s.list().map((x) => x.id), [keep.id]);
    });
  });

  describe('write-through storage', () => {
    let s;
    let storage;
    beforeEach(() => {
      storage = fakeStorage();
      s = createDigestScheduler({ clock: fakeClock().clock, storage });
    });

    it('persists every mutation', () => {
      assert.equal(storage.store.saves, 0);
      const sub = s.subscribe(SUB());
      assert.equal(storage.store.saves, 1);
      s.markSent(sub.id);
      assert.equal(storage.store.saves, 2);
      s.pause(sub.id);
      s.resume(sub.id);
      assert.equal(storage.store.saves, 4);
      s.unsubscribe(sub.id);
      assert.equal(storage.store.saves, 5);
      assert.deepEqual(storage.store.saved.subscriptions, []);
      assert.equal(storage.store.saved.schemaVersion, SCHEMA_VERSION);
    });

    it('hydrates from storage on construction', () => {
      const sub = s.subscribe(SUB({ cadence: 'weekly' }));
      s.markSent(sub.id, 123);
      const s2 = createDigestScheduler({ storage });
      assert.deepEqual(s2.get(sub.id), s.get(sub.id));
    });

    it('rejects a corrupt stored snapshot at construction', () => {
      storage.save({ schemaVersion: 42, subscriptions: [] });
      expectDsError(() => createDigestScheduler({ storage }), 'DS_CORRUPT_SNAPSHOT');
    });

    it('wraps storage failures with DS_STORAGE_FAILURE', () => {
      const bad = {
        save: () => {
          throw new Error('disk gone');
        },
        load: () => null,
      };
      const sBad = createDigestScheduler({ storage: bad });
      expectDsError(() => sBad.subscribe(SUB()), 'DS_STORAGE_FAILURE');
      const badLoad = {
        save: () => {},
        load: () => {
          throw new Error('disk gone');
        },
      };
      expectDsError(() => createDigestScheduler({ storage: badLoad }), 'DS_STORAGE_FAILURE');
    });
  });

  describe('coded-error contract', () => {
    it('every failure path throws an Error with a DS_* code', () => {
      const s = createDigestScheduler();
      const cases = [
        [() => s.unsubscribe('x'), 'DS_NOT_FOUND'],
        [() => s.pause('x'), 'DS_NOT_FOUND'],
        [() => s.resume('x'), 'DS_NOT_FOUND'],
        [() => s.markSent('x'), 'DS_NOT_FOUND'],
        [() => s.nextDue('x'), 'DS_NOT_FOUND'],
        [() => s.subscribe(SUB({ cadence: 'never' })), 'DS_INVALID_SCHEDULE'],
        [() => s.subscribe(SUB({ userId: '' })), 'DS_INVALID_ARGUMENT'],
        [() => s.collect([{}]), 'DS_INVALID_ITEM'],
        [() => s.restore({ bogus: true }), 'DS_CORRUPT_SNAPSHOT'],
      ];
      for (const [fn, code] of cases) {
        expectDsError(fn, code);
      }
    });

    it('coded errors carry a detail object', () => {
      const s = createDigestScheduler();
      try {
        s.subscribe(SUB({ cadence: 'never' }));
        assert.fail('should have thrown');
      } catch (err) {
        assert.equal(err.code, 'DS_INVALID_SCHEDULE');
        assert.ok(err.detail, 'expected a detail object');
        assert.equal(err.detail.cadence, 'never');
      }
    });
  });
});
