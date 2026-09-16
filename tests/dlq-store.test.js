/**
 * dlq-store.test.js — tests for the dead-letter queue store.
 *
 * Covers: enqueue validation, replay success → done, replay failure →
 * queued + attempts++ + lastError, discard, list filters, stats, purge,
 * replayAll, subscriber notifications, snapshot/restore round-trip, corrupt
 * snapshot rejection, and the coded-error contract. Fake clock + in-memory
 * storage keep everything deterministic.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDlqStore, ENTRY_STATES, SNAPSHOT_SCHEMA_VERSION } from '../src/dlq-store.mjs';

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

/** In-memory storage: { storage, saved() }. */
function memoryStorage() {
  const box = { buf: null, saves: 0 };
  return {
    storage: {
      load: () => box.buf,
      save: (serialized) => {
        box.buf = serialized;
        box.saves += 1;
      },
    },
    box,
  };
}

function expectDlqError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

function makeStore(t0 = 1_000_000) {
  const { clock, advance } = fakeClock(t0);
  const { storage, box } = memoryStorage();
  let n = 0;
  const store = createDlqStore({ clock, storage, id: () => `entry-${(n += 1)}` });
  return { store, clock: () => clock(), advance, box, storage };
}

const ENQUEUE = (overrides = {}) => ({
  payload: { job: 'send-mail', to: 'chris@alphacompute.ai' },
  reason: 'SMTP timeout',
  source: 'mailer',
  ...overrides,
});

describe('dlq-store', () => {
  let ctx;
  beforeEach(() => {
    ctx = makeStore();
  });

  it('enqueue: happy path creates a queued entry with attempts=0', () => {
    const { store, clock } = ctx;
    const entry = store.enqueue(ENQUEUE());
    assert.equal(entry.id, 'entry-1');
    assert.deepEqual(entry.payload, { job: 'send-mail', to: 'chris@alphacompute.ai' });
    assert.equal(entry.reason, 'SMTP timeout');
    assert.equal(entry.source, 'mailer');
    assert.equal(entry.enqueuedAt, clock());
    assert.equal(entry.attempts, 0);
    assert.equal(entry.state, 'queued');
    assert.equal(entry.lastError, undefined);
  });

  it('enqueue: validates payload / reason / source with DLQ_INVALID_ENTRY', () => {
    const { store } = ctx;
    expectDlqError(() => store.enqueue(), 'DLQ_INVALID_ENTRY');
    expectDlqError(() => store.enqueue({ reason: 'x', source: 'y' }), 'DLQ_INVALID_ENTRY'); // no payload
    expectDlqError(() => store.enqueue(ENQUEUE({ reason: '' })), 'DLQ_INVALID_ENTRY');
    expectDlqError(() => store.enqueue(ENQUEUE({ reason: '   ' })), 'DLQ_INVALID_ENTRY');
    expectDlqError(() => store.enqueue(ENQUEUE({ reason: 42 })), 'DLQ_INVALID_ENTRY');
    expectDlqError(() => store.enqueue(ENQUEUE({ source: '' })), 'DLQ_INVALID_ENTRY');
    expectDlqError(() => store.enqueue(ENQUEUE({ source: null })), 'DLQ_INVALID_ENTRY');
  });

  it('enqueue: trims reason and source', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE({ reason: '  boom  ', source: '  worker  ' }));
    assert.equal(entry.reason, 'boom');
    assert.equal(entry.source, 'worker');
  });

  it('replay: success moves entry to done', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE());
    let seen = null;
    const after = store.replay(entry.id, (e) => {
      seen = e;
    });
    assert.equal(after.state, 'done');
    assert.equal(after.attempts, 0);
    assert.equal(seen.id, entry.id);
    assert.deepEqual(seen.payload, entry.payload);
    assert.equal(store.get(entry.id).state, 'done');
  });

  it('replay: handler throw puts entry back to queued with attempts++ and lastError (never silent)', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE());
    const after1 = store.replay(entry.id, () => {
      throw new Error('worker exploded');
    });
    assert.equal(after1.state, 'queued');
    assert.equal(after1.attempts, 1);
    assert.equal(after1.lastError, 'worker exploded');

    const after2 = store.replay(entry.id, () => {
      throw new Error('again');
    });
    assert.equal(after2.attempts, 2);
    assert.equal(after2.lastError, 'again');
  });

  it('replay: non-Error throws are stringified into lastError', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE());
    const after = store.replay(entry.id, () => {
      throw 'plain string failure';
    });
    assert.equal(after.state, 'queued');
    assert.equal(after.attempts, 1);
    assert.equal(after.lastError, 'plain string failure');
  });

  it('replay: unknown id throws DLQ_NOT_FOUND; non-function handler throws DLQ_INVALID_HANDLER', () => {
    const { store } = ctx;
    expectDlqError(() => store.replay('nope', () => {}), 'DLQ_NOT_FOUND');
    const entry = store.enqueue(ENQUEUE());
    expectDlqError(() => store.replay(entry.id, 'not-a-fn'), 'DLQ_INVALID_HANDLER');
    expectDlqError(() => store.replay(entry.id), 'DLQ_INVALID_HANDLER');
  });

  it('replay: only queued entries can replay (DLQ_INVALID_STATE)', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE());
    store.replay(entry.id, () => {}); // → done
    expectDlqError(() => store.replay(entry.id, () => {}), 'DLQ_INVALID_STATE');
    const other = store.enqueue(ENQUEUE());
    store.discard(other.id, 'john');
    expectDlqError(() => store.replay(other.id, () => {}), 'DLQ_INVALID_STATE');
  });

  it('replay: a success clears a previously recorded lastError', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE());
    store.replay(entry.id, () => {
      throw new Error('first fails');
    });
    const after = store.replay(entry.id, () => {});
    assert.equal(after.state, 'done');
    assert.equal(after.lastError, undefined);
  });

  it('discard: moves queued entry to discarded with by/note', () => {
    const { store, clock } = ctx;
    const entry = store.enqueue(ENQUEUE());
    const after = store.discard(entry.id, 'john', 'spam run, safe to drop');
    assert.equal(after.state, 'discarded');
    assert.equal(after.discardedBy, 'john');
    assert.equal(after.discardedAt, clock());
    assert.equal(after.note, 'spam run, safe to drop');
  });

  it('discard: unknown id → DLQ_NOT_FOUND; terminal states → DLQ_INVALID_STATE; empty by → DLQ_INVALID_ENTRY', () => {
    const { store } = ctx;
    expectDlqError(() => store.discard('nope', 'john'), 'DLQ_NOT_FOUND');
    const entry = store.enqueue(ENQUEUE());
    expectDlqError(() => store.discard(entry.id, ''), 'DLQ_INVALID_ENTRY');
    store.replay(entry.id, () => {}); // → done
    expectDlqError(() => store.discard(entry.id, 'john'), 'DLQ_INVALID_STATE');
    expectDlqError(() => store.discard(entry.id, 'john'), 'DLQ_INVALID_STATE'); // still done
  });

  it('list: filters by state and source; unknown state filter throws', () => {
    const { store } = ctx;
    const a = store.enqueue(ENQUEUE({ source: 'mailer' }));
    const b = store.enqueue(ENQUEUE({ source: 'worker' }));
    store.replay(a.id, () => {});
    assert.deepEqual(
      store.list().map((e) => e.id).sort(),
      ['entry-1', 'entry-2'],
    );
    assert.deepEqual(store.list({ state: 'done' }).map((e) => e.id), ['entry-1']);
    assert.deepEqual(store.list({ state: 'queued' }).map((e) => e.id), ['entry-2']);
    assert.deepEqual(store.list({ source: 'worker' }).map((e) => e.id), ['entry-2']);
    assert.deepEqual(store.list({ state: 'queued', source: 'worker' }).map((e) => e.id), [
      'entry-2',
    ]);
    assert.deepEqual(store.list({ state: 'queued', source: 'mailer' }), []);
    expectDlqError(() => store.list({ state: 'bogus' }), 'DLQ_INVALID_STATE');
    assert.equal(b.id, 'entry-2');
  });

  it('list/get: snapshots are frozen and do not leak internal state', () => {
    const { store } = ctx;
    const entry = store.enqueue(ENQUEUE());
    assert.ok(Object.isFrozen(entry));
    assert.throws(() => {
      entry.state = 'done';
    });
    assert.equal(store.get(entry.id).state, 'queued');
    assert.equal(store.get('nope'), null);
  });

  it('stats: counts per state plus oldestQueuedAt', () => {
    const { store, advance } = ctx;
    const s0 = store.stats();
    assert.deepEqual(s0, { queued: 0, replaying: 0, discarded: 0, done: 0, oldestQueuedAt: null });

    const a = store.enqueue(ENQUEUE());
    advance(500);
    store.enqueue(ENQUEUE());
    advance(500);
    const c = store.enqueue(ENQUEUE());
    store.replay(a.id, () => {}); // done
    store.discard(c.id, 'john'); // discarded
    const s = store.stats();
    assert.equal(s.queued, 1);
    assert.equal(s.done, 1);
    assert.equal(s.discarded, 1);
    assert.equal(s.replaying, 0);
    assert.equal(s.oldestQueuedAt, a.enqueuedAt + 500);
  });

  it('purge: removes old done entries and returns the count', () => {
    const { store, advance } = ctx;
    const a = store.enqueue(ENQUEUE());
    const b = store.enqueue(ENQUEUE());
    store.replay(a.id, () => {}); // done at t0
    advance(10_000);
    store.replay(b.id, () => {}); // done at t0+10s
    advance(1_000);

    // cutoff t0+11s; purge done entries older than 5s → only `a` qualifies
    const removed = store.purge('done', 5_000);
    assert.equal(removed, 1);
    assert.equal(store.get(a.id), null);
    assert.ok(store.get(b.id));

    // purging again finds nothing
    assert.equal(store.purge('done', 5_000), 0);
  });

  it('purge: defaults to done; unknown state throws; negative window throws', () => {
    const { store, advance } = ctx;
    const a = store.enqueue(ENQUEUE());
    store.replay(a.id, () => {});
    advance(100);
    assert.equal(store.purge(), 1); // default state 'done', olderThanMs 0
    expectDlqError(() => store.purge('bogus'), 'DLQ_INVALID_STATE');
    expectDlqError(() => store.purge('done', -1), 'DLQ_INVALID_ENTRY');
  });

  it('replayAll: replays every queued entry, returns {done, failed}', () => {
    const { store } = ctx;
    store.enqueue(ENQUEUE({ reason: 'ok' }));
    store.enqueue(ENQUEUE({ reason: 'boom' }));
    const d = store.enqueue(ENQUEUE({ reason: 'stays' }));
    store.discard(d.id, 'john'); // not queued → skipped

    const result = store.replayAll((entry) => {
      if (entry.reason === 'boom') throw new Error('handler hates this one');
    });
    assert.deepEqual(result, { done: 1, failed: 1 });
    assert.equal(store.get('entry-2').attempts, 1);
    assert.equal(store.get('entry-2').state, 'queued');
    assert.equal(store.stats().queued, 1);
  });

  it('replayAll: honors limit and validates args', () => {
    const { store } = ctx;
    store.enqueue(ENQUEUE());
    store.enqueue(ENQUEUE());
    const result = store.replayAll(() => {}, { limit: 1 });
    assert.deepEqual(result, { done: 1, failed: 0 });
    assert.equal(store.stats().queued, 1);
    expectDlqError(() => store.replayAll('nope'), 'DLQ_INVALID_HANDLER');
    expectDlqError(() => store.replayAll(() => {}, { limit: -1 }), 'DLQ_INVALID_ENTRY');
    expectDlqError(() => store.replayAll(() => {}, { limit: 1.5 }), 'DLQ_INVALID_ENTRY');
  });

  it('subscribers: notified of enqueued / replay lifecycle / discarded', () => {
    const { store } = ctx;
    const events = [];
    const unsubscribe = store.subscribe((event) => events.push(event));

    const a = store.enqueue(ENQUEUE());
    store.replay(a.id, () => {});
    const b = store.enqueue(ENQUEUE());
    store.replay(b.id, () => {
      throw new Error('nope');
    });
    store.discard(b.id, 'john');

    assert.deepEqual(
      events.map((e) => e.type),
      ['enqueued', 'replay-started', 'replay-succeeded', 'enqueued', 'replay-started', 'replay-failed', 'discarded'],
    );
    assert.ok(events.every((e) => typeof e.at === 'number' && e.entry && e.entry.id));
    assert.ok(Object.isFrozen(events[0]));

    unsubscribe();
    store.enqueue(ENQUEUE());
    assert.equal(events.length, 7);
  });

  it('subscribers: non-function subscribe throws; a throwing subscriber cannot break the queue', () => {
    const { store } = ctx;
    expectDlqError(() => store.subscribe('nope'), 'DLQ_INVALID_SUBSCRIBER');
    store.subscribe(() => {
      throw new Error('bad listener');
    });
    const seen = [];
    store.subscribe((event) => seen.push(event.type));
    const entry = store.enqueue(ENQUEUE()); // must not throw despite the bad listener
    assert.equal(seen[0], 'enqueued');
    assert.equal(store.get(entry.id).state, 'queued');
  });

  it('persistence: mutations are saved to injected storage and hydrated on construction', () => {
    const { storage } = memoryStorage();
    const { clock } = fakeClock();
    const first = createDlqStore({ clock, storage });
    const entry = first.enqueue(ENQUEUE());
    first.replay(entry.id, () => {
      throw new Error('transient');
    });

    const second = createDlqStore({ clock, storage });
    const restored = second.get(entry.id);
    assert.equal(restored.state, 'queued');
    assert.equal(restored.attempts, 1);
    assert.equal(restored.lastError, 'transient');
    assert.equal(second.stats().queued, 1);
  });

  it('snapshot/restore: round-trip preserves entries across a fresh store', () => {
    const { store } = ctx;
    const a = store.enqueue(ENQUEUE());
    const b = store.enqueue(ENQUEUE({ source: 'worker' }));
    store.replay(a.id, () => {
      throw new Error('kaput');
    });
    const snap = store.snapshot();
    const parsed = JSON.parse(snap);
    assert.equal(parsed.version, SNAPSHOT_SCHEMA_VERSION);
    assert.equal(parsed.entries.length, 2);

    const other = createDlqStore();
    const stats = other.restore(snap);
    assert.equal(stats.queued, 2);
    assert.equal(other.get(a.id).attempts, 1);
    assert.equal(other.get(a.id).lastError, 'kaput');
    assert.equal(other.get(b.id).source, 'worker');
  });

  it('restore: replaces (does not merge) existing entries', () => {
    const { store } = ctx;
    store.enqueue(ENQUEUE({ reason: 'old' }));
    const other = createDlqStore();
    other.enqueue(ENQUEUE({ reason: 'new' }));
    const snap = store.snapshot();
    other.restore(snap);
    assert.equal(other.list().length, 1);
    assert.equal(other.list()[0].reason, 'old');
  });

  it('restore: rejects corrupt snapshots with DLQ_CORRUPT_SNAPSHOT', () => {
    const { store } = ctx;
    expectDlqError(() => store.restore('not json{{'), 'DLQ_CORRUPT_SNAPSHOT');
    expectDlqError(() => store.restore('42'), 'DLQ_CORRUPT_SNAPSHOT');
    expectDlqError(() => store.restore('[]'), 'DLQ_CORRUPT_SNAPSHOT');
    expectDlqError(
      () => store.restore(JSON.stringify({ version: 999, entries: [] })),
      'DLQ_CORRUPT_SNAPSHOT',
    );
    expectDlqError(
      () => store.restore(JSON.stringify({ version: 1, entries: 'nope' })),
      'DLQ_CORRUPT_SNAPSHOT',
    );
    expectDlqError(
      () => store.restore(JSON.stringify({ version: 1, entries: [{ id: 'x' }] })),
      'DLQ_CORRUPT_SNAPSHOT',
    );
    expectDlqError(
      () =>
        store.restore(
          JSON.stringify({
            version: 1,
            entries: [
              {
                id: 'x',
                payload: 1,
                reason: 'r',
                source: 's',
                enqueuedAt: 1,
                updatedAt: 1,
                attempts: 0,
                state: 'bogus',
              },
            ],
          }),
        ),
      'DLQ_CORRUPT_SNAPSHOT',
    );
  });

  it('constructor: corrupt data in storage is a loud failure, never a silent empty queue', () => {
    const { storage } = memoryStorage();
    storage.save('garbage');
    const { clock } = fakeClock();
    expectDlqError(() => createDlqStore({ clock, storage }), 'DLQ_CORRUPT_SNAPSHOT');
  });

  it('coded-error contract: every failure carries a code property', () => {
    const { store } = ctx;
    const failures = [
      () => store.enqueue({}),
      () => store.replay('missing', () => {}),
      () => store.discard('missing', 'john'),
      () => store.list({ state: 'wat' }),
      () => store.restore('junk'),
    ];
    for (const fn of failures) {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof Error);
        assert.ok(typeof err.code === 'string' && err.code.startsWith('DLQ_'));
        return true;
      });
    }
  });

  it('exposes ENTRY_STATES and SNAPSHOT_SCHEMA_VERSION', () => {
    assert.deepEqual([...ENTRY_STATES], ['queued', 'replaying', 'discarded', 'done']);
    assert.equal(SNAPSHOT_SCHEMA_VERSION, 1);
  });
});
