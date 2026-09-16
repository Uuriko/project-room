/**
 * snooze-store.test.js — tests for the snooze persistence + wake-up store.
 *
 * Covers: snooze/unsnooze, duplicate rejection, past-wake rejection, list
 * ordering, listDue/wakeDue with fake-clock advance, presets, re-snooze,
 * subscriber notifications, snapshot/restore, corrupt snapshot rejection,
 * storage write-through, and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSnoozeStore,
  SNOOZE_SCHEMA_VERSION,
  SNOOZE_PRESETS,
} from '../src/snooze-store.mjs';

/** Controllable clock: { clock(), advance(ms) }. */
function fakeClock(start = 1_750_000_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** In-memory storage fake: read()/write(raw) over a string slot. */
function memStorage() {
  const slot = { raw: null, writes: 0 };
  return {
    slot,
    read: () => slot.raw,
    write: (raw) => {
      slot.raw = raw;
      slot.writes += 1;
    },
  };
}

function expectSnoozeError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('snooze-store', () => {
  it('snooze stores a record and get returns it', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const rec = store.snooze('msg-1', fc.clock() + HOUR, 'call back', 'inbox');
    assert.equal(rec.messageId, 'msg-1');
    assert.equal(rec.channel, 'inbox');
    assert.equal(rec.note, 'call back');
    assert.equal(rec.state, 'snoozed');
    assert.equal(rec.snoozedAt, fc.clock());
    assert.equal(rec.wakeAt, fc.clock() + HOUR);
    assert.ok(rec.id);
    assert.deepEqual(store.get(rec.id), rec);
    assert.equal(store.get('nope'), null);
  });

  it('accepts a duration as the wake value', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const rec = store.snooze('msg-1', 2 * HOUR, { asDuration: true });
    assert.equal(rec.wakeAt, fc.clock() + 2 * HOUR);
    assert.equal(rec.note, null);
    assert.equal(rec.channel, 'inbox'); // default channel
  });

  it('unsnooze removes the record', () => {
    const store = createSnoozeStore();
    const rec = store.snooze('msg-1', Date.now() + HOUR);
    const removed = store.unsnooze(rec.id);
    assert.equal(removed.id, rec.id);
    assert.equal(store.get(rec.id), null);
    assert.deepEqual(store.list(), []);
    expectSnoozeError(() => store.unsnooze(rec.id), 'SZ_NOT_FOUND');
  });

  it('rejects a second live snooze for the same messageId', () => {
    const store = createSnoozeStore();
    store.snooze('msg-1', Date.now() + HOUR);
    expectSnoozeError(() => store.snooze('msg-1', Date.now() + 2 * HOUR), 'SZ_ALREADY_SNOOZED');
  });

  it('allows a new snooze for the same messageId after unsnooze', () => {
    const store = createSnoozeStore();
    const first = store.snooze('msg-1', Date.now() + HOUR);
    store.unsnooze(first.id);
    const second = store.snooze('msg-1', Date.now() + 2 * HOUR);
    assert.notEqual(second.id, first.id);
    assert.equal(store.list().length, 1);
  });

  it('rejects wakeAt in the past or now', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    expectSnoozeError(() => store.snooze('msg-1', fc.clock() - 1), 'SZ_PAST_WAKE');
    expectSnoozeError(() => store.snooze('msg-1', fc.clock()), 'SZ_PAST_WAKE');
    expectSnoozeError(() => store.snooze('msg-1', 0, { asDuration: true }), 'SZ_INVALID_ARG');
  });

  it('rejects bad arguments with SZ_INVALID_ARG', () => {
    const store = createSnoozeStore();
    expectSnoozeError(() => store.snooze('', Date.now() + HOUR), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.snooze(null, Date.now() + HOUR), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.snooze('msg-1', Number.NaN), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.snooze('msg-1', 'tomorrow'), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.snooze('msg-1', Date.now() + HOUR, 42), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.subscribe('not-a-fn'), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.preset('someday'), 'SZ_INVALID_ARG');
    expectSnoozeError(() => store.listDue(Number.NaN), 'SZ_INVALID_ARG');
  });

  it('list returns live records sorted by wakeAt ascending', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const c = store.snooze('msg-c', fc.clock() + 3 * HOUR);
    const a = store.snooze('msg-a', fc.clock() + HOUR);
    const b = store.snooze('msg-b', fc.clock() + 2 * HOUR);
    assert.deepEqual(
      store.list().map((r) => r.id),
      [a.id, b.id, c.id],
    );
  });

  it('listDue/wakeDue honor the fake clock', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const early = store.snooze('msg-early', fc.clock() + HOUR);
    store.snooze('msg-late', fc.clock() + 5 * HOUR);

    assert.deepEqual(store.listDue(), []);

    fc.advance(2 * HOUR);
    const due = store.listDue();
    assert.deepEqual(due.map((r) => r.id), [early.id]);

    // listDue(now) also accepts an explicit timestamp.
    assert.equal(store.listDue(fc.clock() + 10 * HOUR).length, 2);

    const woken = store.wakeDue();
    assert.deepEqual(woken.map((r) => r.id), [early.id]);
    assert.equal(woken[0].state, 'woken');
    assert.equal(woken[0].wokenAt, fc.clock());

    // Woken items leave the live list and the due list.
    assert.deepEqual(store.list().map((r) => r.messageId), ['msg-late']);
    assert.deepEqual(store.listDue(), []);
  });

  it('wakeDue records an audit entry per woken item', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const a = store.snooze('msg-a', fc.clock() + HOUR);
    const b = store.snooze('msg-b', fc.clock() + HOUR);
    fc.advance(2 * HOUR);
    store.wakeDue(fc.clock(), 'cron');
    const wokenEntries = store.audit.filter((e) => e.type === 'woken');
    assert.equal(wokenEntries.length, 2);
    assert.deepEqual(wokenEntries.map((e) => e.recordId).sort(), [a.id, b.id].sort());
    assert.equal(wokenEntries[0].detail.actor, 'cron');
  });

  it('wakeDue with nothing due returns [] and does not notify', () => {
    const store = createSnoozeStore();
    store.snooze('msg-1', Date.now() + HOUR);
    const events = [];
    store.subscribe((e) => events.push(e));
    assert.deepEqual(store.wakeDue(), []);
    assert.deepEqual(events, []);
  });

  it('re-snooze wakes a woken item back to snoozed', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const rec = store.snooze('msg-1', fc.clock() + HOUR, 'first');
    fc.advance(2 * HOUR);
    const [woken] = store.wakeDue();
    assert.equal(woken.id, rec.id);

    fc.advance(HOUR);
    const again = store.reSnooze(rec.id, 4 * HOUR, { asDuration: true, note: 'second' });
    assert.equal(again.id, rec.id);
    assert.equal(again.state, 'snoozed');
    assert.equal(again.wakeAt, fc.clock() + 4 * HOUR);
    assert.equal(again.note, 'second');
    assert.equal(again.wokenAt, null);
    assert.equal(store.list().length, 1);

    // Cannot re-snooze a record that is still live.
    expectSnoozeError(() => store.reSnooze(rec.id, Date.now() + HOUR), 'SZ_INVALID_STATE');
    expectSnoozeError(() => store.reSnooze('nope', Date.now() + HOUR), 'SZ_NOT_FOUND');
  });

  it('re-snooze accepts a plain note string', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const rec = store.snooze('msg-1', fc.clock() + HOUR);
    fc.advance(2 * HOUR);
    store.wakeDue();
    const again = store.reSnooze(rec.id, fc.clock() + 3 * HOUR, 'plain note');
    assert.equal(again.note, 'plain note');
  });

  it('presets compute wake times from the clock', () => {
    // 2026-09-16 12:00:00 UTC.
    const fc = fakeClock(Date.UTC(2026, 8, 16, 12, 0, 0));
    const store = createSnoozeStore({ clock: fc.clock });
    assert.deepEqual(SNOOZE_PRESETS, ['later-today', 'tomorrow', 'next-week']);

    const laterToday = store.preset('later-today');
    assert.equal(laterToday, Date.UTC(2026, 8, 16, 23, 59, 59, 999));

    const tomorrow = store.preset('tomorrow');
    assert.equal(tomorrow, Date.UTC(2026, 8, 17, 9, 0, 0, 0));

    const nextWeek = store.preset('next-week');
    assert.equal(nextWeek, fc.clock() + 7 * DAY);

    // A preset can be snoozed directly.
    const rec = store.snooze('msg-1', store.preset('tomorrow'));
    assert.equal(rec.wakeAt, tomorrow);
  });

  it('notifies subscribers on snooze/unsnooze/woken/resnoozed', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const events = [];
    const unsubscribe = store.subscribe((e) => events.push(e));

    const rec = store.snooze('msg-1', fc.clock() + HOUR);
    const other = store.snooze('msg-2', fc.clock() + HOUR);
    store.unsnooze(other.id);
    fc.advance(2 * HOUR);
    store.wakeDue();
    store.reSnooze(rec.id, 2 * HOUR, { asDuration: true });

    assert.deepEqual(events.map((e) => e.type), [
      'snoozed',
      'snoozed',
      'unsnoozed',
      'woken',
      'resnoozed',
    ]);
    assert.ok(events.every((e) => e.record && e.record.id), 'each event carries the record');

    unsubscribe();
    store.snooze('msg-3', fc.clock() + HOUR);
    assert.equal(events.length, 5, 'unsubscribed listener gets no more events');
  });

  it('snapshot/restore round-trips state with schema version', () => {
    const fc = fakeClock();
    const store = createSnoozeStore({ clock: fc.clock });
    const a = store.snooze('msg-a', fc.clock() + HOUR, 'note-a');
    fc.advance(2 * HOUR);
    store.wakeDue();
    store.snooze('msg-b', fc.clock() + HOUR);

    const snap = store.snapshot();
    assert.equal(snap.schemaVersion, SNOOZE_SCHEMA_VERSION);
    assert.equal(snap.records.length, 2);

    const store2 = createSnoozeStore({ clock: fc.clock });
    const restored = store2.restore(snap);
    assert.equal(restored.schemaVersion, SNOOZE_SCHEMA_VERSION);
    assert.deepEqual(store2.get(a.id), store.get(a.id));
    assert.deepEqual(
      store2.list().map((r) => r.id),
      store.list().map((r) => r.id),
    );
    assert.ok(store2.audit.some((e) => e.type === 'restored'), 'restore is audited');
  });

  it('rejects corrupt snapshots with SZ_CORRUPT_SNAPSHOT', () => {
    const store = createSnoozeStore();
    expectSnoozeError(() => store.restore(null), 'SZ_CORRUPT_SNAPSHOT');
    expectSnoozeError(() => store.restore({}), 'SZ_CORRUPT_SNAPSHOT');
    expectSnoozeError(
      () => store.restore({ schemaVersion: 999, records: [] }),
      'SZ_CORRUPT_SNAPSHOT',
    );
    expectSnoozeError(
      () => store.restore({ schemaVersion: SNOOZE_SCHEMA_VERSION, records: 'nope' }),
      'SZ_CORRUPT_SNAPSHOT',
    );
    expectSnoozeError(
      () =>
        store.restore({
          schemaVersion: SNOOZE_SCHEMA_VERSION,
          records: [{ id: 'x' }], // missing required fields
        }),
      'SZ_CORRUPT_SNAPSHOT',
    );
    // State is untouched after a failed restore.
    assert.deepEqual(store.list(), []);
  });

  it('writes through to injected storage and loads it on creation', () => {
    const fc = fakeClock();
    const storage = memStorage();
    const store = createSnoozeStore({ clock: fc.clock, storage });
    assert.equal(storage.slot.writes, 0, 'no write until a mutation');

    const rec = store.snooze('msg-1', fc.clock() + HOUR, 'persist me');
    assert.equal(storage.slot.writes, 1);
    const persisted = JSON.parse(storage.slot.raw);
    assert.equal(persisted.schemaVersion, SNOOZE_SCHEMA_VERSION);
    assert.equal(persisted.records[0].messageId, 'msg-1');

    store.unsnooze(rec.id);
    assert.equal(storage.slot.writes, 2);
    assert.equal(JSON.parse(storage.slot.raw).records.length, 0);

    // A new store over the same storage slot resumes the persisted state.
    const store2 = createSnoozeStore({ clock: fc.clock, storage });
    const again = store2.snooze('msg-2', fc.clock() + HOUR);
    const store3 = createSnoozeStore({ clock: fc.clock, storage });
    assert.deepEqual(store3.get(again.id), store2.get(again.id));
  });

  it('throws SZ_CORRUPT_SNAPSHOT when persisted storage is corrupt', () => {
    const storage = memStorage();
    storage.slot.raw = '{not valid json';
    expectSnoozeError(() => createSnoozeStore({ storage }), 'SZ_CORRUPT_SNAPSHOT');

    storage.slot.raw = JSON.stringify({ schemaVersion: 999, records: [] });
    expectSnoozeError(() => createSnoozeStore({ storage }), 'SZ_CORRUPT_SNAPSHOT');
  });

  it('coded-error contract: every failure is an Error with a code', () => {
    const store = createSnoozeStore();
    const seen = new Set();
    const probes = [
      () => store.unsnooze('missing'),
      () => store.snooze('', 1),
      () => store.snooze('m', -5),
      () => store.snooze('m', Date.now() - 1),
      () => store.reSnooze('missing', Date.now() + HOUR),
      () => store.preset('bogus'),
      () => store.restore({}),
    ];
    for (const probe of probes) {
      try {
        probe();
        assert.fail('expected a coded error');
      } catch (err) {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(typeof err.code === 'string' && err.code.startsWith('SZ_'), `bad code: ${err.code}`);
        seen.add(err.code);
      }
    }
    assert.ok(seen.has('SZ_NOT_FOUND'));
    assert.ok(seen.has('SZ_INVALID_ARG'));
    assert.ok(seen.has('SZ_PAST_WAKE'));
    assert.ok(seen.has('SZ_CORRUPT_SNAPSHOT'));
  });

  it('injected id generator is used', () => {
    let n = 0;
    const store = createSnoozeStore({ id: () => `custom-${(n += 1)}` });
    const rec = store.snooze('msg-1', Date.now() + HOUR);
    assert.equal(rec.id, 'custom-1');
  });
});
