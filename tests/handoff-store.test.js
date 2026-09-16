/**
 * handoff-store.test.js — Tests for src/handoff-store.mjs (task B048-2).
 *
 * node:test + node:assert/strict, fake clock + in-memory injected storage,
 * imports from '../src/handoff-store.mjs'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandoffStore,
  HANDOFF_STATES,
  SCHEMA_VERSION,
  MAX_SUMMARY_LENGTH,
} from '../src/handoff-store.mjs';

/** Fake clock: deterministic, manually advanced. */
function fakeClock(start = 1000) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => {
    now += ms;
  };
  return fn;
}

/** In-memory injected storage: satisfies the dep contract. */
function memoryStorage() {
  let held = null;
  return {
    load: () => held,
    save: (snapshot) => {
      held = snapshot;
    },
    peek: () => held,
  };
}

/** Seed a store with sequential ids for readable test assertions. */
function makeStore(overrides = {}) {
  let n = 0;
  const clock = overrides.clock ?? fakeClock();
  const storage = overrides.storage ?? memoryStorage();
  return {
    clock,
    storage,
    store: createHandoffStore({
      clock,
      id: () => `ho-${(n += 1)}`,
      storage,
    }),
  };
}

/** Assert that fn throws an Error with the expected `code`. */
function assertThrowsCode(fn, code) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error, 'must throw an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
  }
  assert.ok(threw, `expected throw with code ${code}`);
}

const PROPOSE = {
  fromAgent: 'quill',
  toAgent: 'instinct',
  taskId: 'B048-2',
  summary: 'Handing off the handoff-store build',
  context: { lane: 'quill-s2' },
};

test('module exports states, schema version, summary limit', () => {
  assert.deepEqual([...HANDOFF_STATES], [
    'proposed',
    'accepted',
    'rejected',
    'completed',
    'cancelled',
  ]);
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(MAX_SUMMARY_LENGTH, 2000);
});

test('propose: creates a proposed handoff with validated fields', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  assert.equal(h.id, 'ho-1');
  assert.equal(h.fromAgent, 'quill');
  assert.equal(h.toAgent, 'instinct');
  assert.equal(h.taskId, 'B048-2');
  assert.equal(h.summary, PROPOSE.summary);
  assert.deepEqual(h.context, { lane: 'quill-s2' });
  assert.equal(h.state, 'proposed');
  assert.equal(h.createdAt, 1000);
  assert.equal(h.decidedAt, null);
  assert.equal(h.decidedBy, null);
  assert.ok(Object.isFrozen(h), 'snapshots are frozen');
});

test('propose: optional taskId/context default', () => {
  const { store } = makeStore();
  const h = store.propose({ fromAgent: 'a', toAgent: 'b', summary: 's' });
  assert.equal(h.taskId, null);
  assert.equal(h.context, undefined);
});

test('propose validation: from===to, empty agents, summary bounds', () => {
  const { store } = makeStore();
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, fromAgent: 'quill', toAgent: 'quill' }),
    'HO_INVALID_HANDOFF',
  );
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, fromAgent: '' }),
    'HO_INVALID_HANDOFF',
  );
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, toAgent: '   ' }),
    'HO_INVALID_HANDOFF',
  );
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, summary: '' }),
    'HO_INVALID_HANDOFF',
  );
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, summary: 'x'.repeat(MAX_SUMMARY_LENGTH + 1) }),
    'HO_INVALID_HANDOFF',
  );
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, taskId: '' }),
    'HO_INVALID_HANDOFF',
  );
  assertThrowsCode(
    () => store.propose({ ...PROPOSE, context: 'nope' }),
    'HO_INVALID_HANDOFF',
  );
  // A 2000-char summary is allowed (upper bound inclusive).
  const ok = store.propose({
    ...PROPOSE,
    summary: 'x'.repeat(MAX_SUMMARY_LENGTH),
  });
  assert.equal(ok.summary.length, MAX_SUMMARY_LENGTH);
});

test('accept: only the recipient may accept from proposed', () => {
  const { clock, store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  clock.advance(50);
  const accepted = store.accept(h.id, 'instinct');
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.decidedAt, 1050);
  assert.equal(accepted.decidedBy, 'instinct');
});

test('accept: unauthorized agent and unknown id', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  assertThrowsCode(() => store.accept(h.id, 'quill'), 'HO_UNAUTHORIZED');
  assertThrowsCode(() => store.accept(h.id, 'stranger'), 'HO_UNAUTHORIZED');
  assertThrowsCode(() => store.accept('ho-missing', 'instinct'), 'HO_NOT_FOUND');
});

test('reject: only the recipient, records reason', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  const rejected = store.reject(h.id, 'instinct', 'busy this wave');
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.rejectReason, 'busy this wave');
  assert.equal(rejected.decidedBy, 'instinct');
  assert.equal(store.get(h.id).state, 'rejected');
});

test('reject: originator may not reject; reason optional', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  assertThrowsCode(() => store.reject(h.id, 'quill', 'nope'), 'HO_UNAUTHORIZED');
  const r2 = store.reject(h.id, 'instinct');
  assert.equal(r2.rejectReason, '');
});

test('complete: only the recipient from accepted', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  assertThrowsCode(
    () => store.complete(h.id, 'instinct', 'done'),
    'HO_INVALID_STATE',
  );
  store.accept(h.id, 'instinct');
  const done = store.complete(h.id, 'instinct', 'shipped green');
  assert.equal(done.state, 'completed');
  assert.equal(done.completeNote, 'shipped green');
  assert.equal(done.decidedBy, 'instinct');
});

test('complete: originator may not complete', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  store.accept(h.id, 'instinct');
  assertThrowsCode(
    () => store.complete(h.id, 'quill', 'not yours'),
    'HO_UNAUTHORIZED',
  );
});

test('cancel: only the originator, only before accept', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  assertThrowsCode(() => store.cancel(h.id, 'instinct'), 'HO_UNAUTHORIZED');
  const cancelled = store.cancel(h.id, 'quill');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.decidedBy, 'quill');
});

test('cancel: not allowed after accept', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  store.accept(h.id, 'instinct');
  assertThrowsCode(() => store.cancel(h.id, 'quill'), 'HO_INVALID_STATE');
});

test('invalid transitions: terminal states reject everything', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  store.reject(h.id, 'instinct');
  assertThrowsCode(() => store.accept(h.id, 'instinct'), 'HO_INVALID_STATE');
  assertThrowsCode(() => store.reject(h.id, 'instinct'), 'HO_INVALID_STATE');
  assertThrowsCode(() => store.complete(h.id, 'instinct'), 'HO_INVALID_STATE');
  assertThrowsCode(() => store.cancel(h.id, 'quill'), 'HO_INVALID_STATE');
});

test('double accept is rejected', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  store.accept(h.id, 'instinct');
  assertThrowsCode(() => store.accept(h.id, 'instinct'), 'HO_INVALID_STATE');
});

test('get: returns snapshot or null; never the internal record', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  const got = store.get(h.id);
  assert.deepEqual(got, h);
  assert.equal(store.get('ho-missing'), null);
  // Snapshots are frozen: mutating them throws and cannot corrupt the store.
  assert.throws(() => {
    got.summary = 'tampered';
  }, TypeError);
  assert.equal(store.get(h.id).summary, PROPOSE.summary);
});

test('list: filters by agentId, state, taskId', () => {
  const { store } = makeStore();
  const h1 = store.propose({ ...PROPOSE }); // quill -> instinct, B048-2
  const h2 = store.propose({ fromAgent: 'instinct', toAgent: 'grokbot', summary: 'two' }); // no taskId
  const h3 = store.propose({ fromAgent: 'codex', toAgent: 'quill', taskId: 'B048-2', summary: 'three' });
  store.accept(h1.id, 'instinct');

  assert.equal(store.list().length, 3);
  assert.equal(store.list({ state: 'proposed' }).length, 2);
  assert.equal(store.list({ state: 'accepted' }).length, 1);
  assert.equal(store.list({ agentId: 'quill' }).length, 2); // from and to both match
  assert.equal(store.list({ agentId: 'grokbot' }).length, 1);
  assert.deepEqual(
    store.list({ agentId: 'grokbot' }).map((h) => h.id),
    [h2.id],
  );
  assert.equal(store.list({ taskId: 'B048-2' }).length, 2);
  const combined = store.list({ agentId: 'quill', state: 'proposed', taskId: 'B048-2' });
  assert.deepEqual(combined.map((h) => h.id), [h3.id]);
});

test('history: append-only per-handoff transitions', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  store.accept(h.id, 'instinct');
  store.complete(h.id, 'instinct', 'done');
  const hist = store.history(h.id);
  assert.deepEqual(
    hist.map((e) => e.to),
    ['proposed', 'accepted', 'completed'],
  );
  assert.ok(hist.every((e) => e.detail && e.detail.handoffId === h.id));
  assertThrowsCode(() => store.history('ho-missing'), 'HO_NOT_FOUND');
  // Another handoff's transitions do not leak in.
  const other = store.propose({ fromAgent: 'a', toAgent: 'b', summary: 'x' });
  store.reject(other.id, 'b');
  assert.equal(store.history(h.id).length, 3);
});

test('audit: global append-only trail mirrors transitions', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  store.accept(h.id, 'instinct');
  store.cancel; // touch nothing
  assert.equal(store.audit.length, 2);
  assert.equal(store.audit[0].to, 'proposed');
  assert.equal(store.audit[0].actor, 'quill');
  assert.equal(store.audit[1].to, 'accepted');
  assert.equal(store.audit[1].actor, 'instinct');
});

test('subscribe: notifications on every transition + unsubscribe', () => {
  const { store } = makeStore();
  const events = [];
  const unsub = store.subscribe((e) => events.push(e));
  const h = store.propose({ ...PROPOSE });
  store.accept(h.id, 'instinct');
  assert.deepEqual(
    events.map((e) => e.type),
    ['proposed', 'accepted'],
  );
  assert.equal(events[0].handoff.id, h.id);
  assert.equal(events[1].actor, 'instinct');
  assert.ok(typeof events[0].at === 'number');
  unsub();
  store.complete(h.id, 'instinct');
  assert.equal(events.length, 2, 'no events after unsubscribe');
  assertThrowsCode(() => store.subscribe('not-a-fn'), 'HO_INVALID_HANDOFF');
});

test('storage: write-through on every mutation', () => {
  const storage = memoryStorage();
  const clock = fakeClock();
  let n = 0;
  const store = createHandoffStore({ clock, id: () => `ho-${(n += 1)}`, storage });
  assert.equal(storage.peek(), null);
  const h = store.propose({ ...PROPOSE });
  const saved = storage.peek();
  assert.equal(saved.schemaVersion, SCHEMA_VERSION);
  assert.equal(saved.handoffs.length, 1);
  assert.equal(saved.handoffs[0].id, h.id);
  store.accept(h.id, 'instinct');
  assert.equal(storage.peek().handoffs[0].state, 'accepted');
});

test('storage errors surface as HO_STORAGE_ERROR, state rolled back', () => {
  const failing = {
    load: () => null,
    save: () => {
      throw new Error('disk on fire');
    },
  };
  const store = createHandoffStore({ clock: fakeClock(), storage: failing });
  assertThrowsCode(() => store.propose({ ...PROPOSE }), 'HO_STORAGE_ERROR');
  assert.equal(store.list().length, 0, 'failed write must not persist in memory');
});

test('snapshot/restore: round-trip preserves handoffs and audit', () => {
  const s1 = makeStore();
  const h = s1.store.propose({ ...PROPOSE });
  s1.store.accept(h.id, 'instinct');
  const snap = s1.store.snapshot();
  assert.equal(snap.schemaVersion, SCHEMA_VERSION);
  assert.ok(typeof snap.savedAt === 'number');

  const s2 = makeStore();
  const count = s2.store.restore(snap, 'quill');
  assert.equal(count, 1);
  assert.deepEqual(s2.store.get(h.id), s1.store.get(h.id));
  // Per-handoff history only covers that handoff's own transitions.
  assert.deepEqual(
    s2.store.history(h.id).map((e) => e.to),
    ['proposed', 'accepted'],
  );
  const audit = s2.store.audit;
  assert.equal(audit[audit.length - 1].to, 'restored');
  assert.equal(audit[audit.length - 1].actor, 'quill');
});

test('restore: load() rehydrates on creation', () => {
  const storage = memoryStorage();
  const mk = () => {
    let n = 0;
    return createHandoffStore({
      clock: fakeClock(),
      id: () => `ho-${(n += 1)}`,
      storage,
    });
  };
  const s1 = mk();
  const h = s1.propose({ ...PROPOSE });
  s1.accept(h.id, 'instinct');
  const s2 = mk(); // constructor rehydrates from storage
  assert.equal(s2.get(h.id).state, 'accepted');
  assert.equal(s2.list().length, 1);
});

test('restore: corrupt snapshots rejected, state untouched', () => {
  const s = makeStore();
  const before = s.store.snapshot();
  const corruptCases = [
    null,
    'string',
    [],
    {},
    { schemaVersion: 999, handoffs: [], audit: [] },
    { schemaVersion: 1, handoffs: 'nope', audit: [] },
    { schemaVersion: 1, handoffs: [], audit: 'nope' },
    { schemaVersion: 1, handoffs: [{ id: 'x' }], audit: [] }, // missing fields
    {
      schemaVersion: 1,
      handoffs: [
        {
          id: 'x',
          fromAgent: 'a',
          toAgent: 'a',
          summary: 's',
          createdAt: 1,
          state: 'proposed',
        },
      ],
      audit: [],
    }, // from === to
    {
      schemaVersion: 1,
      handoffs: [
        {
          id: 'x',
          fromAgent: 'a',
          toAgent: 'b',
          summary: 's',
          createdAt: 1,
          state: 'bogus',
        },
      ],
      audit: [],
    }, // unknown state
    {
      schemaVersion: 1,
      handoffs: [
        { id: 'x', fromAgent: 'a', toAgent: 'b', summary: 's', createdAt: 1, state: 'proposed' },
        { id: 'x', fromAgent: 'a', toAgent: 'b', summary: 's', createdAt: 1, state: 'proposed' },
      ],
      audit: [],
    }, // duplicate ids
  ];
  for (const bad of corruptCases) {
    assertThrowsCode(() => s.store.restore(bad), 'HO_CORRUPT_SNAPSHOT');
  }
  assert.deepEqual(s.store.snapshot().handoffs, before.handoffs, 'state untouched');
});

test('restore: corrupt storage load throws HO_CORRUPT_SNAPSHOT on creation', () => {
  const storage = memoryStorage();
  storage.save({ schemaVersion: 42, handoffs: [], audit: [] });
  assertThrowsCode(
    () => createHandoffStore({ clock: fakeClock(), storage }),
    'HO_CORRUPT_SNAPSHOT',
  );
});

test('coded-error contract: every failure carries err.code', () => {
  const { store } = makeStore();
  const h = store.propose({ ...PROPOSE });
  const cases = [
    [() => store.propose({ fromAgent: 'a', toAgent: 'a', summary: 'x' }), 'HO_INVALID_HANDOFF'],
    [() => store.accept('nope', 'b'), 'HO_NOT_FOUND'],
    [() => store.accept(h.id, 'quill'), 'HO_UNAUTHORIZED'],
    [() => store.complete(h.id, 'instinct'), 'HO_INVALID_STATE'],
    [() => store.reject(h.id, 'quill'), 'HO_UNAUTHORIZED'],
    [() => store.history('nope'), 'HO_NOT_FOUND'],
  ];
  for (const [fn, code] of cases) {
    assertThrowsCode(fn, code);
  }
});

test('decidedAt/decidedBy recorded on every transition', () => {
  const { clock, store } = makeStore();
  const h1 = store.propose({ ...PROPOSE });
  clock.advance(10);
  const r1 = store.reject(h1.id, 'instinct', 'nope');
  assert.equal(r1.decidedAt, 1010);
  assert.equal(r1.decidedBy, 'instinct');

  const h2 = store.propose({ fromAgent: 'a', toAgent: 'b', summary: 'y' });
  clock.advance(10);
  const c2 = store.cancel(h2.id, 'a');
  assert.equal(c2.decidedAt, 1020);
  assert.equal(c2.decidedBy, 'a');
});
