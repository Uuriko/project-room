/**
 * work-claim-store.test.js — tests for the exclusive-lease work-claim store.
 *
 * Covers: exclusive claim per task, exclusive claim per file overlap, duplicate
 * rejection carrying the existing claim id, heartbeat lease extension, sweep
 * expiry, release/complete transitions, queries (byLane/byTask/active/
 * expiringWithin), subscriber notifications, snapshot/restore round-trip,
 * corrupt snapshot rejection, write-through persistence, and the coded-error
 * contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkClaimStore,
  CLAIM_STATES,
  SCHEMA_VERSION,
  DEFAULT_LEASE_TTL_MS,
} from '../src/work-claim-store.mjs';

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

/** In-memory storage fake that also records every save. */
function fakeStorage() {
  return {
    saves: [],
    held: null,
    load() {
      return this.held;
    },
    save(data) {
      this.saves.push(data);
      this.held = data;
    },
  };
}

function makeStore({ start, leaseTtlMs } = {}) {
  const fc = fakeClock(start);
  const storage = fakeStorage();
  const store = createWorkClaimStore({
    clock: fc.clock,
    storage,
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
  });
  return { fc, storage, store };
}

const CLAIM = (overrides = {}) => ({
  taskId: 'B006-2',
  lane: 'quill-s2',
  files: ['src/work-claim-store.mjs'],
  ...overrides,
});

function expectClaimError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('work-claim-store', () => {
  it('claim creates an active claim with a lease', () => {
    const { store } = makeStore();
    const c = store.claim(CLAIM(), 'agent');
    assert.equal(c.state, 'active');
    assert.equal(c.taskId, 'B006-2');
    assert.equal(c.lane, 'quill-s2');
    assert.deepEqual(c.files, ['src/work-claim-store.mjs']);
    assert.equal(c.claimedAt, 1_000_000);
    assert.equal(c.leaseUntil, 1_000_000 + DEFAULT_LEASE_TTL_MS);
    assert.ok(c.id);
    assert.deepEqual(CLAIM_STATES, ['active', 'released', 'expired', 'completed']);
  });

  it('enforces one active claim per taskId', () => {
    const { store } = makeStore();
    const first = store.claim(CLAIM(), 'agent');
    expectClaimError(
      () =>
        store.claim(
          CLAIM({ taskId: 'B006-2', files: ['other-file.mjs'] }),
          'agent',
        ),
      'WC_ALREADY_CLAIMED',
    );
    assert.equal(store.byTask('B006-2').length, 1);
    assert.equal(store.byTask('B006-2')[0].id, first.id);
  });

  it('enforces exclusivity per file path overlap', () => {
    const { store } = makeStore();
    store.claim(CLAIM({ taskId: 'T1', files: ['a.mjs', 'b.mjs'] }), 'agent');
    expectClaimError(
      () => store.claim(CLAIM({ taskId: 'T2', files: ['c.mjs', 'b.mjs'] }), 'agent'),
      'WC_ALREADY_CLAIMED',
    );
    // Disjoint files on a fresh task are fine.
    const ok = store.claim(CLAIM({ taskId: 'T2', files: ['c.mjs'] }), 'agent');
    assert.equal(ok.state, 'active');
  });

  it('duplicate rejection names the existing claim id in detail', () => {
    const { store } = makeStore();
    const first = store.claim(CLAIM(), 'agent');
    try {
      store.claim(CLAIM({ taskId: 'B006-2' }), 'agent');
      assert.fail('expected WC_ALREADY_CLAIMED');
    } catch (err) {
      assert.equal(err.code, 'WC_ALREADY_CLAIMED');
      assert.equal(err.detail.existingClaimId, first.id);
      assert.equal(err.detail.taskId, 'B006-2');
    }
    try {
      store.claim(CLAIM({ taskId: 'other', files: ['src/work-claim-store.mjs'] }), 'agent');
      assert.fail('expected WC_ALREADY_CLAIMED');
    } catch (err) {
      assert.equal(err.code, 'WC_ALREADY_CLAIMED');
      assert.equal(err.detail.existingClaimId, first.id);
      assert.equal(err.detail.via, 'file');
    }
  });

  it('terminal claims free the task and files for re-claim', () => {
    const { store } = makeStore();
    const first = store.claim(CLAIM(), 'agent');
    store.complete(first.id, 'agent');
    const second = store.claim(CLAIM(), 'agent');
    assert.equal(second.state, 'active');
    assert.notEqual(second.id, first.id);
  });

  it('heartbeat extends the lease (active only)', () => {
    const { store, fc } = makeStore();
    const c = store.claim(CLAIM(), 'agent');
    fc.advance(5 * 60 * 1000);
    const beat = store.heartbeat(c.id, 'agent');
    assert.equal(beat.leaseUntil, fc.box.now + DEFAULT_LEASE_TTL_MS);
    assert.ok(beat.leaseUntil > c.leaseUntil);
  });

  it('heartbeat on a non-active claim throws WC_INVALID_TRANSITION', () => {
    const { store } = makeStore();
    const c = store.claim(CLAIM(), 'agent');
    store.release(c.id, 'agent');
    expectClaimError(() => store.heartbeat(c.id, 'agent'), 'WC_INVALID_TRANSITION');
  });

  it('sweep expires stale claims with an audit entry', () => {
    const { store, fc } = makeStore();
    const c1 = store.claim(CLAIM({ taskId: 'T1', files: ['a.mjs'] }), 'agent');
    const c2 = store.claim(CLAIM({ taskId: 'T2', files: ['b.mjs'] }), 'agent');
    fc.advance(DEFAULT_LEASE_TTL_MS + 1);
    const expired = store.sweep('system');
    assert.deepEqual([...expired].sort(), [c1.id, c2.id].sort());
    assert.equal(store.get(c1.id).state, 'expired');
    assert.equal(store.get(c2.id).state, 'expired');
    const expireEntries = store.audit.filter((e) => e.to === 'expired');
    assert.equal(expireEntries.length, 2);
    assert.equal(store.active().length, 0);
  });

  it('sweep leaves fresh claims alone', () => {
    const { store, fc } = makeStore();
    const c = store.claim(CLAIM(), 'agent');
    fc.advance(DEFAULT_LEASE_TTL_MS - 1);
    assert.deepEqual(store.sweep(), []);
    assert.equal(store.get(c.id).state, 'active');
  });

  it('release and complete transitions; repeats are invalid', () => {
    const { store } = makeStore();
    const r = store.claim(CLAIM({ taskId: 'T1', files: ['a.mjs'] }), 'agent');
    assert.equal(store.release(r.id, 'agent').state, 'released');
    expectClaimError(() => store.release(r.id, 'agent'), 'WC_INVALID_TRANSITION');

    const d = store.claim(CLAIM({ taskId: 'T2', files: ['b.mjs'] }), 'agent');
    assert.equal(store.complete(d.id, 'agent').state, 'completed');
    expectClaimError(() => store.release(d.id, 'agent'), 'WC_INVALID_TRANSITION');
    expectClaimError(() => store.heartbeat(d.id, 'agent'), 'WC_INVALID_TRANSITION');
  });

  it('unknown claim id throws WC_NOT_FOUND', () => {
    const { store } = makeStore();
    expectClaimError(() => store.heartbeat('nope', 'agent'), 'WC_NOT_FOUND');
    expectClaimError(() => store.release('nope', 'agent'), 'WC_NOT_FOUND');
    expectClaimError(() => store.complete('nope', 'agent'), 'WC_NOT_FOUND');
    assert.equal(store.get('nope'), null);
  });

  it('queries: byLane, byTask, active, expiringWithin', () => {
    const { store, fc } = makeStore({ leaseTtlMs: 10_000 });
    const a = store.claim(CLAIM({ taskId: 'T1', lane: 'lane-a', files: ['a.mjs'] }), 'agent');
    const b = store.claim(CLAIM({ taskId: 'T2', lane: 'lane-b', files: ['b.mjs'] }), 'agent');
    store.complete(b.id, 'agent');

    assert.deepEqual(store.byLane('lane-a').map((c) => c.id), [a.id]);
    assert.deepEqual(store.byLane('lane-b').map((c) => c.id), [b.id]);
    assert.deepEqual(store.byLane('nope'), []);
    assert.deepEqual(store.byTask('T1').map((c) => c.id), [a.id]);
    assert.deepEqual(store.byTask('T2').map((c) => c.id), [b.id]);
    assert.deepEqual(store.active().map((c) => c.id), [a.id]);

    fc.advance(6_000);
    assert.deepEqual(store.expiringWithin(5_000).map((c) => c.id), [a.id]);
    assert.deepEqual(store.expiringWithin(1_000), []);
  });

  it('subscriber receives notifications for every mutation; unsubscribe works', () => {
    const { store } = makeStore();
    const events = [];
    const unsub = store.subscribe((e) => events.push(e));
    const c = store.claim(CLAIM(), 'agent');
    store.heartbeat(c.id, 'agent');
    store.release(c.id, 'agent');
    const c2 = store.claim(CLAIM({ taskId: 'T2', files: ['b.mjs'] }), 'agent');
    store.complete(c2.id, 'agent');
    const c3 = store.claim(CLAIM({ taskId: 'T3', files: ['c.mjs'] }), 'agent');
    store.sweep('system'); // nothing stale yet
    unsub();
    store.claim(CLAIM({ taskId: 'T4', files: ['d.mjs'] }), 'agent');

    assert.deepEqual(
      events.map((e) => e.type),
      ['claimed', 'heartbeat', 'released', 'claimed', 'completed', 'claimed'],
    );
    assert.ok(events.every((e) => typeof e.at === 'number'));
    assert.equal(events[0].claim.id, c.id);
    assert.equal(events[0].actor, 'agent');
    // c3 still active because nothing advanced the clock
    assert.equal(store.get(c3.id).state, 'active');
  });

  it('snapshot/restore round-trips state; restore validates exclusivity', () => {
    const { fc, store } = makeStore();
    const c = store.claim(CLAIM(), 'agent');
    const snap = store.snapshot();
    assert.equal(snap.schemaVersion, SCHEMA_VERSION);
    assert.equal(snap.claims.length, 1);

    const { store: store2 } = makeStore({ start: 2_000_000 });
    const restoredCount = store2.restore(snap, 'agent');
    assert.equal(restoredCount, 1);
    const got = store2.get(c.id);
    assert.equal(got.state, 'active');
    assert.equal(got.leaseUntil, c.leaseUntil);
    assert.deepEqual(got.files, c.files);

    // Snapshot with two active claims on the same file is corrupt.
    const dupFileSnap = {
      schemaVersion: SCHEMA_VERSION,
      claims: [
        { ...snap.claims[0], id: 'x1' },
        { ...snap.claims[0], id: 'x2' },
      ],
    };
    expectClaimError(() => store2.restore(dupFileSnap), 'WC_CORRUPT_SNAPSHOT');
    // Failed restore leaves current state untouched.
    assert.equal(store2.get(c.id).state, 'active');
    fc.advance(1);
  });

  it('restore rejects corrupt snapshots: wrong version, bad shape, unknown state', () => {
    const { store } = makeStore();
    expectClaimError(() => store.restore(null), 'WC_CORRUPT_SNAPSHOT');
    expectClaimError(() => store.restore({ schemaVersion: 999, claims: [] }), 'WC_CORRUPT_SNAPSHOT');
    expectClaimError(() => store.restore({ schemaVersion: SCHEMA_VERSION }), 'WC_CORRUPT_SNAPSHOT');
    expectClaimError(
      () =>
        store.restore({
          schemaVersion: SCHEMA_VERSION,
          claims: [{ id: 'x', state: 'bogus' }],
        }),
      'WC_CORRUPT_SNAPSHOT',
    );
    expectClaimError(
      () =>
        store.restore({
          schemaVersion: SCHEMA_VERSION,
          claims: [{ id: '', taskId: 'T', files: [], state: 'active', claimedAt: 1, leaseUntil: 2 }],
        }),
      'WC_CORRUPT_SNAPSHOT',
    );
    assert.equal(store.active().length, 0);
  });

  it('write-through: every mutation hits the injected storage', () => {
    const { store, storage } = makeStore();
    assert.equal(storage.saves.length, 0);
    const c = store.claim(CLAIM(), 'agent');
    assert.equal(storage.saves.length, 1);
    assert.equal(storage.saves[0].schemaVersion, SCHEMA_VERSION);
    store.heartbeat(c.id, 'agent');
    store.release(c.id, 'agent');
    store.restore(store.snapshot(), 'agent');
    assert.ok(storage.saves.length >= 4);

    // A fresh store on the same storage rehydrates the last saved state.
    const fc2 = fakeClock(1_000_000);
    const store2 = createWorkClaimStore({ clock: fc2.clock, storage });
    assert.equal(store2.get(c.id).state, 'released');
  });

  it('storage failures surface as WC_STORAGE_ERROR, never silent', () => {
    const fc = fakeClock();
    const badStorage = {
      load: () => null,
      save: () => {
        throw new Error('disk on fire');
      },
    };
    const store = createWorkClaimStore({ clock: fc.clock, storage: badStorage });
    expectClaimError(() => store.claim(CLAIM(), 'agent'), 'WC_STORAGE_ERROR');
    assert.equal(store.active().length, 0);
  });

  it('claim argument validation throws WC_INVALID_CLAIM', () => {
    const { store } = makeStore();
    expectClaimError(() => store.claim({ taskId: '', files: ['a'] }), 'WC_INVALID_CLAIM');
    expectClaimError(() => store.claim({ taskId: 'T', files: [] }), 'WC_INVALID_CLAIM');
    expectClaimError(() => store.claim({ taskId: 'T', files: ['a', 'a'] }), 'WC_INVALID_CLAIM');
    expectClaimError(() => store.claim({ taskId: 'T', files: [42] }), 'WC_INVALID_CLAIM');
    expectClaimError(() => store.claim({ taskId: 'T', files: ['a'], lane: '' }), 'WC_INVALID_CLAIM');
    expectClaimError(() => store.subscribe('not-a-function'), 'WC_INVALID_CLAIM');
  });

  it('coded-error contract: every failure carries a code; none silent', () => {
    const { store } = makeStore();
    const seen = new Set();
    const probes = [
      () => store.claim({ taskId: '', files: ['a'] }),
      () => store.heartbeat('missing'),
      () => store.release('missing'),
      () => store.complete('missing'),
      () => store.restore(null),
    ];
    const c = store.claim(CLAIM(), 'agent');
    probes.push(() => store.claim(CLAIM({ taskId: 'B006-2' }))); // WC_ALREADY_CLAIMED
    probes.push(() => store.claim(CLAIM(), 'agent')); // WC_ALREADY_CLAIMED
    function checkThrow(p) {
      try {
        p();
        assert.fail('expected a throw');
      } catch (err) {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          typeof err.code === 'string' && err.code.startsWith('WC_'),
          `coded, got ${err.code}`,
        );
        seen.add(err.code);
      }
    }
    for (const p of probes) checkThrow(p);
    store.release(c.id); // succeeds — task/lease now free, claim terminal
    checkThrow(() => store.release(c.id)); // WC_INVALID_TRANSITION
    assert.ok(seen.has('WC_INVALID_CLAIM'));
    assert.ok(seen.has('WC_NOT_FOUND'));
    assert.ok(seen.has('WC_CORRUPT_SNAPSHOT'));
    assert.ok(seen.has('WC_ALREADY_CLAIMED'));
    assert.ok(seen.has('WC_INVALID_TRANSITION'));
  });
});
