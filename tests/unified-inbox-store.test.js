/**
 * unified-inbox-store.test.js — tests for the unified inbox store.
 *
 * Covers: upsert/get, list filters + sort + cursor pagination, read/unread
 * toggles, star/unstar, delete, subscriber notifications, snapshot/restore
 * round-trip, version migration (v1 → v2), corrupt snapshot rejection,
 * version-conflict rejection, storage write-through verification, and the
 * coded-error contract.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUnifiedInboxStore,
  migrate,
  SCHEMA_VERSION,
  CHANNELS,
} from '../src/unified-inbox-store.mjs';

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

/** In-memory storage fake: records every set() call for verification. */
function fakeStorage() {
  const map = new Map();
  const sets = [];
  return {
    sets,
    get: (key) => (map.has(key) ? map.get(key) : undefined),
    set: (key, value) => {
      sets.push({ key, value });
      map.set(key, value);
    },
    raw: map,
  };
}

const MSG = (overrides = {}) => ({
  channel: 'email',
  ts: 1_000_000,
  from: 'chris@alphacompute.ai',
  subject: 'Intro',
  body: 'hello',
  ...overrides,
});

function expectCodedError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('unified-inbox-store', () => {
  let fc;
  let storage;
  let store;

  beforeEach(() => {
    fc = fakeClock();
    storage = fakeStorage();
    store = createUnifiedInboxStore({ clock: fc.clock, storage });
  });

  describe('upsert and get', () => {
    it('upserts a message with a generated id and returns a frozen record', () => {
      const created = store.upsertMessage(MSG({ id: 'm-1' }));
      assert.equal(created.id, 'm-1');
      assert.equal(created.channel, 'email');
      assert.equal(created.read, false);
      assert.equal(created.starred, false);
      assert.ok(Object.isFrozen(created));

      const generated = store.upsertMessage(MSG());
      assert.match(generated.id, /^msg-\d+$/);
    });

    it('getMessage returns the record, and null for unknown ids', () => {
      store.upsertMessage(MSG({ id: 'm-1' }));
      const got = store.getMessage('m-1');
      assert.equal(got.subject, 'Intro');
      assert.equal(store.getMessage('nope'), null);
    });

    it('upsert with an existing id updates instead of duplicating', () => {
      store.upsertMessage(MSG({ id: 'm-1', subject: 'first' }));
      const updated = store.upsertMessage(MSG({ id: 'm-1', subject: 'second' }));
      assert.equal(updated.subject, 'second');
      assert.equal(store.size, 1);
      assert.equal(store.getMessage('m-1').subject, 'second');
    });

    it('rejects invalid payloads with UIS_INVALID_MESSAGE', () => {
      expectCodedError(() => store.upsertMessage(null), 'UIS_INVALID_MESSAGE');
      expectCodedError(() => store.upsertMessage(MSG({ channel: 'smoke-signal' })), 'UIS_INVALID_MESSAGE');
      expectCodedError(() => store.upsertMessage(MSG({ ts: Number.NaN })), 'UIS_INVALID_MESSAGE');
      expectCodedError(() => store.upsertMessage(MSG({ read: 'yes' })), 'UIS_INVALID_MESSAGE');
      expectCodedError(() => store.upsertMessage(MSG({ id: '' })), 'UIS_INVALID_MESSAGE');
    });
  });

  describe('list filters, sort, pagination', () => {
    beforeEach(() => {
      store.upsertMessage(MSG({ id: 'a', channel: 'email', ts: 300, read: false, starred: false }));
      store.upsertMessage(MSG({ id: 'b', channel: 'telegram', ts: 100, read: true, starred: true }));
      store.upsertMessage(MSG({ id: 'c', channel: 'whatsapp', ts: 200, read: false, starred: true }));
      store.upsertMessage(MSG({ id: 'd', channel: 'email', ts: 400, read: true, starred: false }));
    });

    it('sorts by ts desc', () => {
      const ids = store.list().messages.map((m) => m.id);
      assert.deepEqual(ids, ['d', 'a', 'c', 'b']);
    });

    it('filters by channel', () => {
      const ids = store.list({ channel: 'email' }).messages.map((m) => m.id);
      assert.deepEqual(ids, ['d', 'a']);
    });

    it('filters by read flag', () => {
      const unread = store.list({ read: false }).messages.map((m) => m.id);
      assert.deepEqual(unread, ['a', 'c']);
      const read = store.list({ read: true }).messages.map((m) => m.id);
      assert.deepEqual(read, ['d', 'b']);
    });

    it('filters by starred flag', () => {
      const starred = store.list({ starred: true }).messages.map((m) => m.id);
      assert.deepEqual(starred, ['c', 'b']);
    });

    it('combines filters', () => {
      const ids = store.list({ channel: 'email', read: true }).messages.map((m) => m.id);
      assert.deepEqual(ids, ['d']);
    });

    it('paginates with cursor and limit', () => {
      const page1 = store.list({ limit: 2 });
      assert.deepEqual(page1.messages.map((m) => m.id), ['d', 'a']);
      assert.equal(page1.nextCursor, 'a');

      const page2 = store.list({ limit: 2, cursor: page1.nextCursor });
      assert.deepEqual(page2.messages.map((m) => m.id), ['c', 'b']);
      assert.equal(page2.nextCursor, null);

      // Exhausted cursor yields an empty last page.
      const page3 = store.list({ limit: 2, cursor: page2.messages[1].id });
      assert.deepEqual(page3.messages, []);
      assert.equal(page3.nextCursor, null);
    });

    it('rejects unknown cursors and bad pagination args', () => {
      expectCodedError(() => store.list({ cursor: 'ghost' }), 'UIS_INVALID_ARG');
      expectCodedError(() => store.list({ limit: 0 }), 'UIS_INVALID_ARG');
      expectCodedError(() => store.list({ limit: 1.5 }), 'UIS_INVALID_ARG');
      expectCodedError(() => store.list({ channel: 'pager' }), 'UIS_INVALID_MESSAGE');
      expectCodedError(() => store.list({ read: 'no' }), 'UIS_INVALID_ARG');
    });
  });

  describe('read/star toggles and delete', () => {
    beforeEach(() => {
      store.upsertMessage(MSG({ id: 'm-1' }));
    });

    it('markRead / markUnread flip the flag', () => {
      assert.equal(store.markRead('m-1').read, true);
      assert.equal(store.getMessage('m-1').read, true);
      assert.equal(store.markUnread('m-1').read, false);
      assert.equal(store.getMessage('m-1').read, false);
    });

    it('star / unstar flip the flag', () => {
      assert.equal(store.star('m-1').starred, true);
      assert.equal(store.unstar('m-1').starred, false);
    });

    it('deleteMessage removes the message and returns true', () => {
      assert.equal(store.deleteMessage('m-1'), true);
      assert.equal(store.getMessage('m-1'), null);
      assert.equal(store.size, 0);
    });

    it('mutations on unknown ids throw UIS_NOT_FOUND', () => {
      expectCodedError(() => store.markRead('ghost'), 'UIS_NOT_FOUND');
      expectCodedError(() => store.markUnread('ghost'), 'UIS_NOT_FOUND');
      expectCodedError(() => store.star('ghost'), 'UIS_NOT_FOUND');
      expectCodedError(() => store.unstar('ghost'), 'UIS_NOT_FOUND');
      expectCodedError(() => store.deleteMessage('ghost'), 'UIS_NOT_FOUND');
    });
  });

  describe('subscribers', () => {
    it('notifies subscribers on every mutation, in order', () => {
      const events = [];
      const unsubscribe = store.subscribe((e) => events.push(e.type));

      store.upsertMessage(MSG({ id: 'm-1' }));
      store.upsertMessage(MSG({ id: 'm-1', subject: 'edited' }));
      store.markRead('m-1');
      store.star('m-1');
      store.unstar('m-1');
      store.markUnread('m-1');
      store.deleteMessage('m-1');

      assert.deepEqual(events, [
        'message-created',
        'message-updated',
        'message-read',
        'message-starred',
        'message-unstarred',
        'message-unread',
        'message-deleted',
      ]);

      unsubscribe();
      store.upsertMessage(MSG({ id: 'm-2' }));
      assert.equal(events.length, 7, 'no events after unsubscribe');
    });

    it('accepts initial subscribers via deps.onChange (single fn or array)', () => {
      const seen = [];
      const s2 = createUnifiedInboxStore({
        clock: fc.clock,
        storage,
        onChange: (e) => seen.push(e.type),
      });
      s2.upsertMessage(MSG({ id: 'x' }));
      assert.deepEqual(seen, ['message-created']);

      const seen2 = [];
      const s3 = createUnifiedInboxStore({
        clock: fc.clock,
        storage: fakeStorage(),
        onChange: [(e) => seen2.push(e.type)],
      });
      s3.upsertMessage(MSG({ id: 'y' }));
      assert.deepEqual(seen2, ['message-created']);
    });

    it('event payloads carry messageId and the injected clock time', () => {
      const events = [];
      store.subscribe((e) => events.push(e));
      fc.advance(5_000);
      store.upsertMessage(MSG({ id: 'm-1' }));
      assert.equal(events[0].type, 'message-created');
      assert.equal(events[0].messageId, 'm-1');
      assert.equal(events[0].at, 1_005_000);
    });

    it('subscribe rejects non-functions and unsubscribe() removes', () => {
      expectCodedError(() => store.subscribe('nope'), 'UIS_INVALID_ARG');
      const events = [];
      const fn = (e) => events.push(e.type);
      store.subscribe(fn);
      store.unsubscribe(fn);
      store.upsertMessage(MSG({ id: 'm-1' }));
      assert.equal(events.length, 0);
    });
  });

  describe('snapshot and restore', () => {
    it('round-trips state through snapshot/restore', () => {
      store.upsertMessage(MSG({ id: 'a', channel: 'telegram', ts: 10, read: true }));
      store.upsertMessage(MSG({ id: 'b', channel: 'whatsapp', ts: 20, starred: true }));
      const snap = store.snapshot();
      assert.equal(snap.version, SCHEMA_VERSION);

      const fresh = fakeStorage();
      const s2 = createUnifiedInboxStore({ clock: fc.clock, storage: fresh });
      s2.restore(snap);
      assert.deepEqual(s2.list().messages.map((m) => m.id), ['b', 'a']);
      assert.equal(s2.getMessage('a').read, true);
      assert.equal(s2.getMessage('b').starred, true);
      // Restored state was written through to the fresh storage.
      assert.equal(fresh.raw.get(s2.storageKey).version, SCHEMA_VERSION);
    });

    it('restore emits a store-restored event', () => {
      const events = [];
      store.subscribe((e) => events.push(e.type));
      store.restore({ version: SCHEMA_VERSION, messages: [MSG({ id: 'm-1' })] });
      assert.deepEqual(events, ['store-restored']);
    });

    it('restore replaces existing state rather than merging', () => {
      store.upsertMessage(MSG({ id: 'old' }));
      store.restore({ version: SCHEMA_VERSION, messages: [MSG({ id: 'new' })] });
      assert.equal(store.getMessage('old'), null);
      assert.ok(store.getMessage('new'));
    });

    it('migrates a v1 snapshot (seen → read, starred default)', () => {
      const v1 = {
        version: 1,
        messages: [
          { id: 'm-1', channel: 'email', ts: 5, from: 'a', subject: 's', body: 'b', seen: true },
          { id: 'm-2', channel: 'telegram', ts: 6, from: 'a', subject: 's', body: 'b', seen: false },
        ],
      };
      const migrated = migrate(v1);
      assert.equal(migrated.version, SCHEMA_VERSION);
      assert.equal(migrated.messages[0].read, true);
      assert.equal(migrated.messages[1].read, false);
      assert.equal(migrated.messages[0].starred, false);
      assert.ok(!('seen' in migrated.messages[0]));

      store.restore(v1);
      assert.equal(store.getMessage('m-1').read, true);
      assert.equal(store.getMessage('m-1').starred, false);
    });

    it('treats a versionless snapshot with messages as v1', () => {
      const migrated = migrate({
        messages: [{ id: 'm-1', channel: 'email', ts: 5, seen: true }],
      });
      assert.equal(migrated.version, SCHEMA_VERSION);
      assert.equal(migrated.messages[0].read, true);
    });

    it('rejects corrupt snapshots with UIS_CORRUPT_SNAPSHOT', () => {
      for (const bad of [null, 42, 'snap', {}, { version: 2 }, { version: 2, messages: 'no' }]) {
        expectCodedError(() => store.restore(bad), 'UIS_CORRUPT_SNAPSHOT');
      }
      expectCodedError(
        () => store.restore({ version: 2, messages: [{ id: 'm-1', channel: 'email' }] }),
        'UIS_CORRUPT_SNAPSHOT',
      );
      expectCodedError(
        () => store.restore({ version: 2, messages: ['not-an-object'] }),
        'UIS_CORRUPT_SNAPSHOT',
      );
    });

    it('rejects newer snapshot versions with UIS_VERSION_CONFLICT', () => {
      expectCodedError(
        () => store.restore({ version: SCHEMA_VERSION + 1, messages: [] }),
        'UIS_VERSION_CONFLICT',
      );
      expectCodedError(
        () => migrate({ version: 99, messages: [] }),
        'UIS_VERSION_CONFLICT',
      );
    });

    it('does not mutate the caller snapshot during migration', () => {
      const v1 = {
        version: 1,
        messages: [{ id: 'm-1', channel: 'email', ts: 5, seen: true }],
      };
      store.restore(v1);
      assert.equal(v1.version, 1, 'caller snapshot version untouched');
      assert.equal(v1.messages[0].seen, true, 'caller message untouched');
    });
  });

  describe('storage write-through', () => {
    it('persists on every mutation and hydrates on construction', () => {
      assert.equal(storage.sets.length, 0);
      store.upsertMessage(MSG({ id: 'm-1' }));
      store.markRead('m-1');
      store.star('m-1');
      store.deleteMessage('m-1');
      store.upsertMessage(MSG({ id: 'm-2', channel: 'whatsapp' }));
      assert.equal(storage.sets.length, 5);
      for (const s of storage.sets) {
        assert.equal(s.key, store.storageKey);
        assert.equal(s.value.version, SCHEMA_VERSION);
      }
      const last = storage.sets[storage.sets.length - 1].value;
      assert.deepEqual(last.messages.map((m) => m.id), ['m-2']);

      // A new store on the same storage hydrates the persisted state.
      const s2 = createUnifiedInboxStore({ clock: fc.clock, storage });
      assert.equal(s2.size, 1);
      assert.equal(s2.getMessage('m-2').channel, 'whatsapp');
    });

    it('wraps storage failures in UIS_STORAGE_ERROR (never silent)', () => {
      const failing = {
        get: () => undefined,
        set: () => {
          throw new Error('disk gone');
        },
      };
      const s = createUnifiedInboxStore({ clock: fc.clock, storage: failing });
      expectCodedError(() => s.upsertMessage(MSG({ id: 'm-1' })), 'UIS_STORAGE_ERROR');
    });

    it('wraps storage read failures in UIS_STORAGE_ERROR', () => {
      const failingRead = {
        get: () => {
          throw new Error('read gone');
        },
        set: () => {},
      };
      expectCodedError(
        () => createUnifiedInboxStore({ clock: fc.clock, storage: failingRead }),
        'UIS_STORAGE_ERROR',
      );
    });
  });

  describe('coded-error contract', () => {
    it('every thrown failure is an Error with a string code', () => {
      const fns = [
        () => store.markRead('ghost'),
        () => store.deleteMessage('ghost'),
        () => store.upsertMessage(MSG({ channel: 'irc' })),
        () => store.list({ cursor: 'ghost' }),
        () => store.restore(null),
        () => store.restore({ version: 99, messages: [] }),
      ];
      for (const fn of fns) {
        assert.throws(fn, (err) => {
          assert.ok(err instanceof Error);
          assert.equal(typeof err.code, 'string');
          assert.match(err.code, /^UIS_/);
          return true;
        });
      }
    });

    it('exports SCHEMA_VERSION and CHANNELS', () => {
      assert.equal(typeof SCHEMA_VERSION, 'number');
      assert.deepEqual([...CHANNELS], ['email', 'telegram', 'whatsapp']);
    });
  });
});
