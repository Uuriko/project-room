import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentReputation,
  tier,
  EVENT_TYPES,
  EVENT_DELTAS,
  START_SCORE,
  MIN_SCORE,
  MAX_SCORE,
} from '../src/agent-reputation.mjs';

/** Fake clock: advance it manually to drive lazy decay. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
  };
  clock.set = (ms) => {
    now = ms;
  };
  return clock;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRep(clock, decayRate) {
  return createAgentReputation({ clock, ...(decayRate === undefined ? {} : { decayRate }) });
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected throw with code ${code}, but nothing threw`);
}

describe('agent-reputation', () => {
  it('starts every agent at 500 and applies signed deltas', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    assert.equal(rep.record('a1', { type: 'completed' }).score, START_SCORE + 10);
    assert.equal(rep.record('a1', { type: 'helpful' }).score, START_SCORE + 15);
    assert.equal(rep.record('a1', { type: 'failed' }).score, START_SCORE - 5);
    assert.equal(rep.record('a1', { type: 'harmful' }).score, START_SCORE - 55);
    assert.equal(rep.record('a1', { type: 'timeout' }).score, START_SCORE - 70);
    const snap = rep.score('a1');
    assert.equal(snap.events, 5);
    assert.equal(snap.lastActiveAt, clock());
  });

  it('clamps scores to the 0..1000 range', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    // 100 harmful events of 50 points each would go far below zero.
    for (let i = 0; i < 100; i += 1) {
      clock.advance(61_000); // dodge the per-minute duplicate guard
      rep.record('floor', { type: 'harmful', weight: 10 });
    }
    assert.equal(rep.score('floor').score, MIN_SCORE);

    for (let i = 0; i < 100; i += 1) {
      clock.advance(61_000);
      rep.record('ceiling', { type: 'completed', weight: 10 });
    }
    assert.equal(rep.score('ceiling').score, MAX_SCORE);
  });

  it('decays scores toward 500 lazily on read', () => {
    const clock = fakeClock();
    const rep = makeRep(clock, 0.01);
    rep.record('d1', { type: 'completed' }); // 510
    rep.record('d2', { type: 'harmful' }); // 450
    assert.equal(rep.score('d1').score, 510);
    clock.advance(10 * DAY_MS);
    const after10 = rep.score('d1').score;
    const expected = 500 + 10 * Math.pow(0.99, 10);
    assert.ok(Math.abs(after10 - expected) < 0.01, `decay after 10d: ${after10} vs ${expected}`);
    const below = rep.score('d2').score;
    const expectedBelow = 500 - 50 * Math.pow(0.99, 10);
    assert.ok(Math.abs(below - expectedBelow) < 0.01, `decay from below: ${below} vs ${expectedBelow}`);
    // Decay never overshoots 500.
    clock.advance(1000 * DAY_MS);
    const settled = rep.score('d1').score;
    assert.ok(settled >= 500 && settled <= 510.001, `converges to 500: ${settled}`);
  });

  it('decay of zero deviation stays put and a zero decayRate holds score', () => {
    const clock = fakeClock();
    const flat = makeRep(clock, 0);
    flat.record('f1', { type: 'completed' });
    clock.advance(365 * DAY_MS);
    assert.equal(flat.score('f1').score, 510);

    const rep = makeRep(clock);
    rep.record('f2', { type: 'completed' }); // 510
    // Immediately re-read: no time elapsed, no change.
    assert.equal(rep.score('f2').score, 510);
  });

  it('returns leaderboard sorted descending', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    rep.record('low', { type: 'failed' }); // 480
    rep.record('mid', { type: 'completed' }); // 510
    rep.record('high', { type: 'helpful', weight: 10 }); // 550
    const board = rep.leaderboard({ limit: 3 });
    assert.deepEqual(board.map((r) => r.agentId), ['high', 'mid', 'low']);
    assert.deepEqual(board.map((r) => r.score), [550, 510, 480]);
    assert.deepEqual(board.map((r) => r.tier), ['fair', 'fair', 'fair']);
  });

  it('leaderboard honors limit and minEvents', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    rep.record('veteran', { type: 'completed' });
    clock.advance(61_000);
    rep.record('veteran', { type: 'helpful' });
    rep.record('newbie', { type: 'completed', weight: 10 }); // higher score, fewer events
    const limited = rep.leaderboard({ limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].agentId, 'newbie');
    const filtered = rep.leaderboard({ limit: 10, minEvents: 2 });
    assert.deepEqual(filtered.map((r) => r.agentId), ['veteran']);
  });

  it('reset() restores 500, clears history, and writes an audit entry', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    rep.record('r1', { type: 'harmful' });
    rep.record('r1', { type: 'failed' });
    const before = rep.audit.length;
    const snap = rep.reset('r1', 'fresh start after retraining');
    assert.equal(snap.score, START_SCORE);
    assert.equal(snap.events, 0);
    assert.equal(rep.history('r1', 10).length, 0);
    assert.equal(rep.audit.length, before + 1);
    const entry = rep.audit[rep.audit.length - 1];
    assert.equal(entry.action, 'reset');
    assert.equal(entry.agentId, 'r1');
    assert.equal(entry.detail.reason, 'fresh start after retraining');
    expectCode(() => rep.reset('r1', ''), 'AR_INVALID_REASON');
  });

  it('tier() honors every boundary', () => {
    assert.equal(tier(1000), 'excellent');
    assert.equal(tier(800), 'excellent');
    assert.equal(tier(799.99), 'good');
    assert.equal(tier(600), 'good');
    assert.equal(tier(599.99), 'fair');
    assert.equal(tier(400), 'fair');
    assert.equal(tier(399.99), 'poor');
    assert.equal(tier(200), 'poor');
    assert.equal(tier(199.99), 'bad');
    assert.equal(tier(0), 'bad');
    expectCode(() => tier(NaN), 'AR_INVALID_SCORE');
  });

  it('rejects a second event of the same type within one minute', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    rep.record('g1', { type: 'completed' });
    expectCode(() => rep.record('g1', { type: 'completed' }), 'AR_DUPLICATE_EVENT');
    // Same minute, different type is fine.
    rep.record('g1', { type: 'helpful' });
    assert.equal(rep.score('g1').score, 515);
    // After a minute the same type is accepted again.
    clock.advance(60_000);
    rep.record('g1', { type: 'completed' });
    assert.equal(rep.score('g1').score, 525);
    // Rejections are noted in the audit log and never move the score silently.
    const rejects = rep.audit.filter((e) => e.action === 'record-rejected');
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].detail.type, 'completed');
  });

  it('validates weight into [0.1, 10]', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    for (const bad of [0, 0.09, 10.01, -1, NaN, Infinity, 'big']) {
      expectCode(() => rep.record('w1', { type: 'completed', weight: bad }), 'AR_INVALID_WEIGHT');
    }
    // null/undefined weight defaults to 1.
    assert.equal(rep.record('w0', { type: 'completed', weight: null }).score, START_SCORE + 10);
    assert.equal(rep.record('w1', { type: 'completed', weight: 0.1 }).score, 501);
    clock.advance(61_000);
    assert.equal(rep.record('w1', { type: 'completed', weight: 10 }).score, 601);
  });

  it('enforces the coded-error contract everywhere', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);

    expectCode(() => rep.record('', { type: 'completed' }), 'AR_INVALID_AGENT_ID');
    expectCode(() => rep.record('x', { type: 'celebrated' }), 'AR_INVALID_EVENT_TYPE');
    expectCode(() => rep.record('x', { type: 'completed', at: -1 }), 'AR_INVALID_TIMESTAMP');
    expectCode(() => rep.record('x', { type: 'completed', at: 'now' }), 'AR_INVALID_TIMESTAMP');
    expectCode(() => rep.score('ghost'), 'AR_NOT_FOUND');
    expectCode(() => rep.history('ghost', 10), 'AR_NOT_FOUND');
    expectCode(() => rep.reset('ghost', 'reason'), 'AR_NOT_FOUND');
    expectCode(() => rep.leaderboard({ limit: 0 }), 'AR_INVALID_LIMIT');
    expectCode(() => createAgentReputation({ clock, decayRate: 2 }), 'AR_INVALID_DECAY_RATE');

    // Every thrown failure carries `code` on the Error itself.
    for (const code of ['AR_INVALID_AGENT_ID', 'AR_NOT_FOUND', 'AR_INVALID_EVENT_TYPE']) {
      const err = (() => {
        try {
          if (code === 'AR_NOT_FOUND') rep.score('nobody-here');
          else if (code === 'AR_INVALID_EVENT_TYPE') rep.record('x', { type: 'nope' });
          else rep.record(null, { type: 'completed' });
        } catch (e) {
          return e;
        }
        return null;
      })();
      assert.ok(err instanceof Error, 'failures throw Error instances');
      assert.equal(err.code, code);
    }
  });

  it('weight multiplies the signed delta', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    rep.record('m1', { type: 'harmful', weight: 2 }); // -50 * 2 = -100
    assert.equal(rep.score('m1').score, 400);
  });

  it('history() returns frozen events, newest first', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    rep.record('h1', { type: 'completed', weight: 3 });
    clock.advance(61_000);
    rep.record('h1', { type: 'helpful' });
    const hist = rep.history('h1', 10);
    assert.equal(hist.length, 2);
    assert.equal(hist[0].type, 'helpful');
    assert.equal(hist[1].type, 'completed');
    assert.equal(hist[1].delta, 30);
    assert.ok(Object.isFrozen(hist[0]), 'event entries are frozen');
  });

  it('snapshots are frozen and tier is included', () => {
    const clock = fakeClock();
    const rep = makeRep(clock);
    const snap = rep.record('s1', { type: 'completed', weight: 10 }); // 600
    assert.ok(Object.isFrozen(snap), 'snapshot is frozen');
    assert.equal(snap.tier, 'good');
    assert.throws(() => {
      snap.score = 0;
    }, TypeError);
  });

  it('exports the expected constants', () => {
    assert.deepEqual([...EVENT_TYPES], ['completed', 'failed', 'helpful', 'harmful', 'timeout']);
    assert.deepEqual({ ...EVENT_DELTAS }, { completed: 10, helpful: 5, failed: -20, harmful: -50, timeout: -15 });
  });
});
