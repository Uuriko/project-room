/**
 * thread-view-store.test.js — tests for the per-thread view-state store.
 *
 * Covers: per-thread isolation, default record shape, draft text round-trip,
 * mute toggle, seen-up-to, scroll anchor + selected message, reset,
 * listViews filters, clear, subscriber notifications, snapshot/restore,
 * corrupt snapshot rejection, version conflict, storage write-through, and
 * the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createThreadViewStore,
  SCHEMA_VERSION,
  DEFAULT_STORAGE_KEY,
} from '../src/thread-view-store.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
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

/** In-memory storage fake that records every write. */
function fakeStorage() {
  const map = new Map();
  const writes = [];
  return {
    writes,
    get: (key) => (map.has(key) ? map.get(key) : undefined),
    set: (key, value) => {
      writes.push({ key, value });
      map.set(key, value);
    },
  };
}

function expectTvError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('thread-view-store', () => {
  it('new threads start from the default view record', () => {
    const { clock } = fakeClock();
    const store = createThreadViewStore({ clock });

    assert.equal(store.getViewState('t-1'), null, 'unknown thread reads null (no throw)');

    const created = store.setViewState('t-1', {});
    assert.deepEqual(
      { ...created },
      {
        threadId: 't-1',
        expanded: false,
        scrollAnchor: null,
        selectedMessageId: null,
        draftText: '',
        muted: false,
        seenUpTo: null,
        updatedAt: 2_000_000,
      },
    );
    assert.ok(Object.isFrozen(created), 'records are frozen snapshots');
    assert.equal(store.size, 1);
  });

  it('set/get view state per thread id, with patch merge', () => {
    const { clock, advance } = fakeClock();
    const store = createThreadViewStore({ clock });

    store.setViewState('t-1', { expanded: true, scrollAnchor: 'm-9' });
    advance(10);
    const updated = store.setViewState('t-1', { selectedMessageId: 'm-9', muted: true });

    assert.equal(updated.expanded, true, 'patch merges, does not replace');
    assert.equal(updated.scrollAnchor, 'm-9');
    assert.equal(updated.selectedMessageId, 'm-9');
    assert.equal(updated.muted, true);
    assert.equal(updated.updatedAt, 2_000_010);

    const read = store.getViewState('t-1');
    assert.equal(read.expanded, true);
    assert.equal(read.selectedMessageId, 'm-9');

    // Mutating the returned snapshot must not affect the store.
    assert.throws(() => {
      read.expanded = false;
    }, TypeError);
  });

  it('per-thread isolation: records never leak across threads', () => {
    const store = createThreadViewStore();
    store.setViewState('t-1', { expanded: true });
    store.updateDraft('t-2', 'hello from t-2');
    store.toggleMute('t-3');

    assert.equal(store.getViewState('t-1').expanded, true);
    assert.equal(store.getViewState('t-1').draftText, '');
    assert.equal(store.getViewState('t-2').expanded, false);
    assert.equal(store.getViewState('t-2').draftText, 'hello from t-2');
    assert.equal(store.getViewState('t-3').muted, true);
    assert.equal(store.getViewState('t-1').muted, false);
    assert.equal(store.size, 3);
  });

  it('draft text round-trips per thread', () => {
    const store = createThreadViewStore();
    store.updateDraft('t-1', 'first draft…');
    assert.equal(store.getViewState('t-1').draftText, 'first draft…');

    store.updateDraft('t-1', '');
    assert.equal(store.getViewState('t-1').draftText, '', 'empty string clears the draft');

    // Draft state composes with the rest of the view state.
    store.setViewState('t-1', { expanded: true });
    assert.equal(store.getViewState('t-1').draftText, '');
    assert.equal(store.getViewState('t-1').expanded, true);

    expectTvError(() => store.updateDraft('t-1', 42), 'TV_INVALID_ARG');
    expectTvError(() => store.updateDraft('t-1', null), 'TV_INVALID_ARG');
    expectTvError(() => store.updateDraft('t-1', undefined), 'TV_INVALID_ARG');
  });

  it('mute toggle flips and reports the new state', () => {
    const store = createThreadViewStore();
    const on = store.toggleMute('t-1');
    assert.equal(on.muted, true);
    assert.equal(store.getViewState('t-1').muted, true);

    const off = store.toggleMute('t-1');
    assert.equal(off.muted, false);
    assert.equal(store.getViewState('t-1').muted, false);
  });

  it('markSeen sets and clears the seen-up-to marker', () => {
    const store = createThreadViewStore();
    const seen = store.markSeen('t-1', 'm-42');
    assert.equal(seen.seenUpTo, 'm-42');
    assert.equal(store.getViewState('t-1').seenUpTo, 'm-42');

    store.markSeen('t-1', 'm-50');
    assert.equal(store.getViewState('t-1').seenUpTo, 'm-50');

    store.markSeen('t-1', null);
    assert.equal(store.getViewState('t-1').seenUpTo, null);

    expectTvError(() => store.markSeen('t-1', ''), 'TV_INVALID_ARG');
    expectTvError(() => store.markSeen('t-1', 7), 'TV_INVALID_ARG');
  });

  it('resetThreadView drops the record; unknown threads throw TV_NOT_FOUND', () => {
    const store = createThreadViewStore();
    store.setViewState('t-1', { expanded: true });
    store.setViewState('t-2', { expanded: true });
    assert.equal(store.size, 2);

    store.resetThreadView('t-1');
    assert.equal(store.getViewState('t-1'), null);
    assert.equal(store.getViewState('t-2').expanded, true);
    assert.equal(store.size, 1);

    expectTvError(() => store.resetThreadView('t-1'), 'TV_NOT_FOUND');
    expectTvError(() => store.resetThreadView('never-seen'), 'TV_NOT_FOUND');
  });

  it('listViews returns threads sorted by id with muted/expanded filters', () => {
    const store = createThreadViewStore();
    store.setViewState('t-c', {});
    store.setViewState('t-a', { muted: true });
    store.setViewState('t-b', { expanded: true });

    const all = store.listViews();
    assert.deepEqual(all.map((v) => v.threadId), ['t-a', 't-b', 't-c']);

    assert.deepEqual(
      store.listViews({ muted: true }).map((v) => v.threadId),
      ['t-a'],
    );
    assert.deepEqual(
      store.listViews({ muted: false }).map((v) => v.threadId),
      ['t-b', 't-c'],
    );
    assert.deepEqual(
      store.listViews({ expanded: true }).map((v) => v.threadId),
      ['t-b'],
    );
    assert.deepEqual(store.listViews({ muted: true, expanded: true }), []);

    expectTvError(() => store.listViews({ muted: 'yes' }), 'TV_INVALID_ARG');
    expectTvError(() => store.listViews({ expanded: 1 }), 'TV_INVALID_ARG');
  });

  it('clear drops all view state in one go', () => {
    const events = [];
    const store = createThreadViewStore({ onChange: (e) => events.push(e) });
    store.setViewState('t-1', {});
    store.setViewState('t-2', {});
    assert.equal(store.size, 2);

    store.clear();
    assert.equal(store.size, 0);
    assert.deepEqual(store.listViews(), []);
    assert.equal(store.getViewState('t-1'), null);

    const last = events.at(-1);
    assert.equal(last.type, 'cleared');
  });

  it('subscriber notifications: create/update events carry the thread id', () => {
    const seen = [];
    const store = createThreadViewStore();
    const unsubscribe = store.subscribe((e) => seen.push(e));

    store.setViewState('t-1', { expanded: true });
    store.setViewState('t-1', { muted: true });
    store.setViewState('t-1', { muted: true }); // no-op: no event
    store.updateDraft('t-1', 'draft');
    store.toggleMute('t-2');
    store.markSeen('t-1', 'm-1');
    store.resetThreadView('t-2');

    assert.deepEqual(
      seen.map((e) => e.type),
      ['view-created', 'view-updated', 'draft-updated', 'mute-toggled', 'seen-updated', 'view-reset'],
    );
    assert.deepEqual(
      seen.map((e) => e.threadId),
      ['t-1', 't-1', 't-1', 't-2', 't-1', 't-2'],
    );
    const muteEvent = seen.find((e) => e.type === 'mute-toggled');
    assert.equal(muteEvent.muted, true);
    const seenEvent = seen.find((e) => e.type === 'seen-updated');
    assert.equal(seenEvent.seenUpTo, 'm-1');

    // Events carry an id and an at timestamp, and are frozen.
    for (const event of seen) {
      assert.ok(typeof event.id === 'string', 'event has an id');
      assert.ok(typeof event.at === 'number', 'event has an at timestamp');
      assert.ok(Object.isFrozen(event), 'events are frozen');
    }

    // Unsubscribe stops delivery.
    unsubscribe();
    store.setViewState('t-3', {});
    assert.equal(seen.length, 6, 'no event after unsubscribe');
  });

  it('initial onChange subscribers from deps receive events; bad ones throw', () => {
    const seenA = [];
    const seenB = [];
    const store = createThreadViewStore({
      onChange: [(e) => seenA.push(e), (e) => seenB.push(e)],
    });
    store.setViewState('t-1', {});
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);

    expectTvError(() => createThreadViewStore({ onChange: [() => {}, 'nope'] }), 'TV_INVALID_ARG');
    expectTvError(() => store.subscribe('not-a-function'), 'TV_INVALID_ARG');
  });

  it('snapshot/restore round-trips state between stores', () => {
    const { clock, advance } = fakeClock();
    const store = createThreadViewStore({ clock });
    store.setViewState('t-1', { expanded: true, scrollAnchor: 'm-1' });
    advance(5);
    store.updateDraft('t-2', 'unsent composer text');
    store.toggleMute('t-2');
    advance(5);
    store.markSeen('t-2', 'm-8');

    const snap = store.snapshot();
    assert.equal(snap.version, SCHEMA_VERSION);
    assert.equal(snap.threads.length, 2);
    const t2 = snap.threads.find((t) => t.threadId === 't-2');
    assert.equal(t2.draftText, 'unsent composer text');
    assert.equal(t2.muted, true);
    assert.equal(t2.seenUpTo, 'm-8');

    const other = createThreadViewStore({ clock });
    const events = [];
    other.subscribe((e) => events.push(e));
    other.restore(snap);

    assert.deepEqual(other.getViewState('t-1'), store.getViewState('t-1'));
    assert.deepEqual(other.getViewState('t-2'), store.getViewState('t-2'));
    assert.equal(other.size, 2);
    assert.equal(events.at(-1).type, 'restored');
    assert.equal(events.at(-1).threadCount, 2);

    // Restore replaces, not merges.
    other.restore({ version: SCHEMA_VERSION, threads: [] });
    assert.equal(other.size, 0);
  });

  it('restore rejects corrupt snapshots with TV_CORRUPT_SNAPSHOT', () => {
    const store = createThreadViewStore();
    const good = () => store.snapshot();

    for (const bad of [
      null,
      undefined,
      42,
      'snap',
      [],
      {},
      { version: SCHEMA_VERSION }, // no threads array
      { version: SCHEMA_VERSION, threads: null },
      { version: SCHEMA_VERSION, threads: 'nope' },
      { version: SCHEMA_VERSION, threads: [null] },
      { version: SCHEMA_VERSION, threads: ['nope'] },
      // missing threadId
      {
        version: SCHEMA_VERSION,
        threads: [{ expanded: true, draftText: '', muted: false }],
      },
      // non-boolean flag
      {
        version: SCHEMA_VERSION,
        threads: [
          {
            threadId: 't-1',
            expanded: 'yes',
            scrollAnchor: null,
            selectedMessageId: null,
            draftText: '',
            muted: false,
            seenUpTo: null,
            updatedAt: 1,
          },
        ],
      },
      // non-string draftText
      {
        version: SCHEMA_VERSION,
        threads: [
          {
            threadId: 't-1',
            expanded: false,
            scrollAnchor: null,
            selectedMessageId: null,
            draftText: 7,
            muted: false,
            seenUpTo: null,
            updatedAt: 1,
          },
        ],
      },
      // non-finite updatedAt
      {
        version: SCHEMA_VERSION,
        threads: [
          {
            threadId: 't-1',
            expanded: false,
            scrollAnchor: null,
            selectedMessageId: null,
            draftText: '',
            muted: false,
            seenUpTo: null,
            updatedAt: Number.NaN,
          },
        ],
      },
      // bad scroll anchor
      {
        version: SCHEMA_VERSION,
        threads: [
          {
            threadId: 't-1',
            expanded: false,
            scrollAnchor: 9,
            selectedMessageId: null,
            draftText: '',
            muted: false,
            seenUpTo: null,
            updatedAt: 1,
          },
        ],
      },
      // duplicate thread ids
      {
        version: SCHEMA_VERSION,
        threads: [
          {
            threadId: 't-1',
            expanded: false,
            scrollAnchor: null,
            selectedMessageId: null,
            draftText: '',
            muted: false,
            seenUpTo: null,
            updatedAt: 1,
          },
          {
            threadId: 't-1',
            expanded: true,
            scrollAnchor: null,
            selectedMessageId: null,
            draftText: '',
            muted: false,
            seenUpTo: null,
            updatedAt: 2,
          },
        ],
      },
      // unknown snapshot version (older than current, no migration defined)
      { version: 0, threads: [] },
    ]) {
      expectTvError(() => store.restore(bad), 'TV_CORRUPT_SNAPSHOT');
      // Failed restores leave existing state untouched.
      assert.deepEqual(store.snapshot(), good(), 'state untouched after corrupt restore');
    }
  });

  it('restore rejects newer snapshot versions with TV_VERSION_CONFLICT', () => {
    const store = createThreadViewStore();
    expectTvError(
      () => store.restore({ version: SCHEMA_VERSION + 1, threads: [] }),
      'TV_VERSION_CONFLICT',
    );
    assert.equal(store.size, 0, 'state untouched after version conflict');
  });

  it('storage write-through persists on every mutation under the storage key', () => {
    const storage = fakeStorage();
    const store = createThreadViewStore({ storage });

    store.setViewState('t-1', { expanded: true });
    store.updateDraft('t-1', 'draft text');
    store.toggleMute('t-1');
    store.markSeen('t-1', 'm-3');
    store.setViewState('t-2', {});
    store.resetThreadView('t-2');
    store.clear();

    assert.ok(storage.writes.length >= 7, 'one write per mutation');
    for (const { key, value } of storage.writes) {
      assert.equal(key, DEFAULT_STORAGE_KEY);
      assert.equal(value.version, SCHEMA_VERSION);
      assert.ok(Array.isArray(value.threads), 'persisted snapshot has threads array');
    }
    const last = storage.writes.at(-1).value;
    assert.deepEqual(last.threads, [], 'clear() persists the empty state');
  });

  it('honours a custom storageKey', () => {
    const storage = fakeStorage();
    const store = createThreadViewStore({ storage, storageKey: 'custom:key' });
    assert.equal(store.storageKey, 'custom:key');
    store.setViewState('t-1', {});
    assert.equal(storage.writes[0].key, 'custom:key');
  });

  it('wraps storage failures as TV_STORAGE_ERROR (never silent)', () => {
    const broken = {
      get: () => undefined,
      set: () => {
        throw new Error('disk gone');
      },
    };
    const store = createThreadViewStore({ storage: broken });
    expectTvError(() => store.setViewState('t-1', {}), 'TV_STORAGE_ERROR');
  });

  it('coded-error contract: every failure carries a code', () => {
    const store = createThreadViewStore();

    // Bad thread ids.
    for (const bad of ['', 42, null, undefined, {}]) {
      expectTvError(() => store.setViewState(bad, {}), 'TV_INVALID_ARG');
      expectTvError(() => store.getViewState(bad), 'TV_INVALID_ARG');
      expectTvError(() => store.updateDraft(bad, 'x'), 'TV_INVALID_ARG');
      expectTvError(() => store.toggleMute(bad), 'TV_INVALID_ARG');
      expectTvError(() => store.markSeen(bad, 'm-1'), 'TV_INVALID_ARG');
      expectTvError(() => store.resetThreadView(bad), 'TV_INVALID_ARG');
    }

    // Bad patches.
    expectTvError(() => store.setViewState('t-1', { expanded: 'yes' }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', { muted: 1 }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', { scrollAnchor: 9 }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', { scrollAnchor: '' }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', { selectedMessageId: [] }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', { draftText: null }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', { bogusField: true }), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', 'nope'), 'TV_INVALID_ARG');
    expectTvError(() => store.setViewState('t-1', null), 'TV_INVALID_ARG');

    // Codes are exact strings, never undefined.
    try {
      store.resetThreadView('ghost');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.code, 'TV_NOT_FOUND');
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0);
    }
  });

  it('SCHEMA_VERSION and DEFAULT_STORAGE_KEY are exported', () => {
    assert.equal(SCHEMA_VERSION, 1);
    assert.equal(DEFAULT_STORAGE_KEY, 'thread-view:v1');
  });

  it('injected id generator names change events', () => {
    const seen = [];
    const store = createThreadViewStore({
      id: (() => {
        let n = 0;
        return () => `evt-${(n += 1)}`;
      })(),
      onChange: (e) => seen.push(e),
    });
    store.setViewState('t-1', {});
    assert.equal(seen[0].id, 'evt-1');
  });

  it('fake clock drives updatedAt', () => {
    const { clock, advance } = fakeClock();
    const store = createThreadViewStore({ clock });
    store.updateDraft('t-1', 'a');
    assert.equal(store.getViewState('t-1').updatedAt, 2_000_000);
    advance(250);
    store.updateDraft('t-1', 'b');
    assert.equal(store.getViewState('t-1').updatedAt, 2_000_250);
  });
});
