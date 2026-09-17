/**
 * multi-instance-election.test.js — tests for the bully-ish lease election.
 *
 * Covers: first acquirer wins, second sees the leader, expired-lease takeover,
 * renew extension, renew/reject paths, fencing-token monotonicity,
 * onLeadershipLost notification, release, isLeader, stepdown, and the
 * coded-error contract. Uses a fake clock and an in-memory lockStore.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createElection,
  createMemoryLockStore,
  ELECTION_ERRORS,
  DEFAULT_LEASE_TTL_MS,
} from '../src/multi-instance-election.mjs';

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

/** Two election participants sharing one lease store, like two instances. */
function twoInstances(start) {
  const t = fakeClock(start);
  const store = createMemoryLockStore();
  const a = createElection({ clock: t.clock, lockStore: store });
  const b = createElection({ clock: t.clock, lockStore: store });
  return { t, store, a, b };
}

function expectElectionError(fn, code) {
  assert.ok(
    ELECTION_ERRORS.includes(code),
    `test bug: ${code} is not a documented election error code`,
  );
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('multi-instance-election', () => {
  it('first acquirer wins; second sees the current leader', () => {
    const { a, b } = twoInstances();
    const won = a.acquire('a', { ttlMs: 1000 });
    assert.equal(won.leader, true);
    assert.equal(won.token, 1);

    const lost = b.acquire('b', { ttlMs: 1000 });
    assert.equal(lost.leader, false);
    assert.equal(lost.currentLeader, 'a');
  });

  it('an expired lock can be taken by another instance', () => {
    const { t, a, b } = twoInstances();
    a.acquire('a', { ttlMs: 1000 });
    t.advance(1001);

    const takeover = b.acquire('b', { ttlMs: 1000 });
    assert.equal(takeover.leader, true);
    assert.equal(takeover.currentLeader, undefined);
    assert.equal(b.isLeader('b'), true);
    assert.equal(a.isLeader('a'), false);
  });

  it('acquire by the current live holder throws EL_LOCK_HELD', () => {
    const { a } = twoInstances();
    a.acquire('a', { ttlMs: 1000 });
    expectElectionError(() => a.acquire('a', { ttlMs: 1000 }), 'EL_LOCK_HELD');
  });

  it('renew extends the TTL past the original expiry', () => {
    const { t, a } = twoInstances();
    a.acquire('a', { ttlMs: 1000 });
    t.advance(800);
    const renewed = a.renew('a');
    assert.equal(renewed.leader, true);
    assert.equal(renewed.token, 1);
    assert.equal(renewed.expiresAt, t.clock() + 1000);

    // 800 + 900 = 1700ms after acquire — past the original 1000ms lease,
    // but the renewed lease is still live.
    t.advance(900);
    assert.equal(a.isLeader('a'), true);
    t.advance(200);
    assert.equal(a.isLeader('a'), false);
  });

  it('renew by a non-holder is rejected with EL_NOT_LEADER', () => {
    const { a, b } = twoInstances();
    a.acquire('a', { ttlMs: 1000 });
    expectElectionError(() => b.renew('b'), 'EL_NOT_LEADER');
    expectElectionError(() => b.renew('never-held'), 'EL_NOT_LEADER');
  });

  it('fencing token increases monotonically across acquisitions', () => {
    const { t, a, b } = twoInstances();
    assert.equal(a.acquire('a', { ttlMs: 100 }).token, 1);
    t.advance(101);
    assert.equal(b.acquire('b', { ttlMs: 100 }).token, 2);
    t.advance(101);
    assert.equal(a.acquire('a', { ttlMs: 100 }).token, 3);
    t.advance(101);
    assert.equal(b.acquire('b', { ttlMs: 100 }).token, 4);
  });

  it('onLeadershipLost fires when renew discovers the lock was taken', () => {
    const { t, a, b } = twoInstances();
    const events = [];
    a.onLeadershipLost((e) => events.push(e));

    a.acquire('a', { ttlMs: 100 });
    t.advance(101);
    b.acquire('b', { ttlMs: 10_000 });

    expectElectionError(() => a.renew('a'), 'EL_LOCK_LOST');
    assert.equal(events.length, 1);
    assert.equal(events[0].instanceId, 'a');
    assert.equal(events[0].token, 2);
    assert.equal(events[0].reason, 'lock-lost');
    assert.ok(typeof events[0].at === 'number');
  });

  it('onLeadershipLost returns an unregister function; bad listener rejected', () => {
    const { t, a, b } = twoInstances();
    const events = [];
    const off = a.onLeadershipLost((e) => events.push(e));
    off();

    a.acquire('a', { ttlMs: 100 });
    t.advance(101);
    b.acquire('b', { ttlMs: 10_000 });
    expectElectionError(() => a.renew('a'), 'EL_LOCK_LOST');
    assert.equal(events.length, 0);

    expectElectionError(() => a.onLeadershipLost('nope'), 'EL_INVALID_ARGS');
  });

  it('release frees the lock; only the holder may release', () => {
    const { a, b } = twoInstances();
    a.acquire('a', { ttlMs: 10_000 });
    // Non-holder cannot release a live lease held by someone else.
    expectElectionError(() => b.release('b'), 'EL_LOCK_HELD');

    const out = a.release('a');
    assert.equal(out.released, true);
    assert.equal(out.token, 1);
    assert.equal(a.isLeader('a'), false);
    // A tombstone remains so the fencing-token chain survives the release.
    assert.equal(a.status().holder, null);
    assert.equal(a.status().live, false);

    // Now anyone can acquire.
    const next = b.acquire('b', { ttlMs: 10_000 });
    assert.equal(next.leader, true);
    assert.equal(next.token, 2);
  });

  it('release by an instance that lost the lock throws EL_LOCK_LOST', () => {
    const { t, a, b } = twoInstances();
    a.acquire('a', { ttlMs: 100 });
    t.advance(101);
    b.acquire('b', { ttlMs: 10_000 });
    expectElectionError(() => a.release('a'), 'EL_LOCK_LOST');
  });

  it('isLeader reports holder, non-holder, and expiry correctly', () => {
    const { t, a, b } = twoInstances();
    assert.equal(a.isLeader('a'), false);
    a.acquire('a', { ttlMs: 500 });
    assert.equal(a.isLeader('a'), true);
    assert.equal(b.isLeader('b'), false);
    t.advance(500);
    assert.equal(a.isLeader('a'), false);
    // Explicit `now` parameter is honored.
    assert.equal(a.isLeader('a', t.clock() - 1), true);
  });

  it('stepdown voluntarily yields; a peer can acquire immediately', () => {
    const { a, b } = twoInstances();
    const events = [];
    a.onLeadershipLost((e) => events.push(e));

    a.acquire('a', { ttlMs: 10_000 });
    const down = a.stepdown('a');
    assert.equal(down.steppedDown, true);
    assert.equal(down.token, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'stepdown');

    const next = b.acquire('b', { ttlMs: 10_000 });
    assert.equal(next.leader, true);

    // Stepping down when not leader is a graceful no-op, never a throw.
    const noop = b.stepdown('a');
    assert.deepEqual(noop, { steppedDown: false, currentLeader: 'b' });
  });

  it('status returns a read-only snapshot of the lease', () => {
    const { t, a } = twoInstances();
    assert.equal(a.status(), null);
    a.acquire('a', { ttlMs: 500, startedAt: 42 });
    const s = a.status();
    assert.equal(s.holder, 'a');
    assert.equal(s.token, 1);
    assert.equal(s.startedAt, 42);
    assert.equal(s.live, true);
    assert.throws(() => {
      s.holder = 'x';
    });
    t.advance(500);
    assert.equal(a.status().live, false);
  });

  it('coded-error contract: invalid args fail loudly, never silently', () => {
    const { a } = twoInstances();
    expectElectionError(() => a.acquire('', { ttlMs: 1000 }), 'EL_INVALID_ARGS');
    expectElectionError(() => a.acquire('a', { ttlMs: 0 }), 'EL_INVALID_ARGS');
    expectElectionError(() => a.acquire('a', { ttlMs: -5 }), 'EL_INVALID_ARGS');
    expectElectionError(() => a.acquire('a', { ttlMs: NaN }), 'EL_INVALID_ARGS');
    expectElectionError(() => a.renew(''), 'EL_INVALID_ARGS');
    expectElectionError(() => a.release(123), 'EL_INVALID_ARGS');
    a.acquire('a', { ttlMs: 1000 });
    expectElectionError(() => a.renew('a', { ttlMs: 0 }), 'EL_INVALID_ARGS');
  });

  it('default ttl and generated instance ids work', () => {
    const { t } = twoInstances();
    const store = createMemoryLockStore();
    const a = createElection({ clock: t.clock, lockStore: store });
    // Default id generators are per-election counters; give the second
    // participant its own generator so ids do not collide.
    const b = createElection({
      clock: t.clock,
      lockStore: store,
      id: (() => {
        let n = 0;
        return () => `peer-${(n += 1)}`;
      })(),
    });
    assert.equal(DEFAULT_LEASE_TTL_MS, 30_000);
    const first = a.acquire();
    assert.equal(first.leader, true);
    assert.ok(typeof first.token === 'number');
    const second = b.acquire();
    assert.equal(second.leader, false);
    assert.ok(typeof second.currentLeader === 'string');
  });

  it('lockStore sees exactly the lease records (minimal interface)', () => {
    const t = fakeClock();
    const seen = [];
    const store = {
      get: () => seen.at(-1)?.op === 'set' ? seen.at(-1).record : null,
      set: (record) => seen.push({ op: 'set', record: { ...record } }),
      del: () => seen.push({ op: 'del' }),
    };
    const e = createElection({ clock: t.clock, lockStore: store });
    e.acquire('a', { ttlMs: 1000 });
    e.release('a');
    assert.deepEqual(
      seen.map((s) => s.op),
      ['set', 'set'],
    );
    assert.equal(seen[0].record.holder, 'a');
    assert.equal(seen[0].record.token, 1);
    // Release writes a tombstone (holder null), preserving the token chain.
    assert.equal(seen[1].record.holder, null);
    assert.equal(seen[1].record.token, 1);
    assert.equal(seen[1].record.releasedBy, 'a');
  });
});
