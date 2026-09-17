/**
 * capability-broadcast.test.js — tests for the capability broadcast planner.
 *
 * Covers: debounce coalescing, window-lapse firing, flush, version increment,
 * view, subscriber payload, prune, diff added/removed, unchanged dedupe, and
 * the coded-error contract. Uses a fake clock and a fake announce sink.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityBroadcast, diffCaps, DEFAULT_DEBOUNCE_MS } from '../src/capability-broadcast.mjs';

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

/** Fake announce sink recording every payload it receives. */
function fakeAnnounce() {
  const calls = [];
  return {
    calls,
    announce: (payload) => {
      calls.push(payload);
    },
  };
}

function make(deps = {}) {
  const fc = fakeClock();
  const fa = fakeAnnounce();
  const broadcast = createCapabilityBroadcast({
    clock: fc.clock,
    announce: fa.announce,
    ...deps,
  });
  return { broadcast, fc, fa };
}

function expectCbError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('capability-broadcast', () => {
  it('debounce coalesces rapid changes into one announce with the latest set', () => {
    const { broadcast, fa } = make();
    broadcast.announceCaps('agent-1', ['read']);
    broadcast.announceCaps('agent-1', ['read', 'write']);
    broadcast.announceCaps('agent-1', ['read', 'write', 'exec']);
    assert.equal(fa.calls.length, 0, 'nothing announced inside the window');
    const flushed = broadcast.flush();
    assert.deepEqual(flushed, ['agent-1']);
    assert.equal(fa.calls.length, 1, 'one coalesced announce');
    assert.deepEqual(fa.calls[0].capabilities, ['read', 'write', 'exec']);
    assert.equal(fa.calls[0].agentId, 'agent-1');
  });

  it('window lapse fires pending on the next announceCaps call', () => {
    const { broadcast, fc, fa } = make();
    broadcast.announceCaps('agent-1', ['read']);
    fc.advance(DEFAULT_DEBOUNCE_MS + 1);
    const res = broadcast.announceCaps('agent-2', ['ping']);
    assert.equal(fa.calls.length, 1, 'lapsed pending fired');
    assert.equal(fa.calls[0].agentId, 'agent-1');
    assert.equal(res.announced, true);
    assert.equal(broadcast.pendingCount, 1, 'agent-2 change now pending');
  });

  it('flush forces pending immediately and returns announced agentIds', () => {
    const { broadcast, fa } = make();
    broadcast.announceCaps('agent-1', ['a']);
    broadcast.announceCaps('agent-2', ['b']);
    const flushed = broadcast.flush();
    assert.deepEqual(flushed, ['agent-1', 'agent-2']);
    assert.equal(fa.calls.length, 2);
    assert.deepEqual(broadcast.flush(), [], 'second flush is a no-op');
  });

  it('version increments once per actual announce', () => {
    const { broadcast, fc, fa } = make();
    broadcast.announceCaps('agent-1', ['read']);
    broadcast.flush();
    assert.equal(fa.calls[0].version, 1);
    broadcast.announceCaps('agent-1', ['read']); // unchanged → dedupe, no announce
    broadcast.announceCaps('agent-1', ['read', 'write']);
    fc.advance(DEFAULT_DEBOUNCE_MS);
    // Window lapsed: the next call fires the pending ['read','write'] as
    // announce #2, then stages ['read','write','exec'] as new pending.
    broadcast.announceCaps('agent-1', ['read', 'write', 'exec']);
    broadcast.flush();
    assert.equal(fa.calls.length, 3);
    assert.deepEqual(fa.calls[1].capabilities, ['read', 'write']);
    assert.equal(fa.calls[1].version, 2);
    assert.deepEqual(fa.calls[2].capabilities, ['read', 'write', 'exec']);
    assert.equal(fa.calls[2].version, 3);
    assert.equal(broadcast.view('agent-1').version, 3);
  });

  it('view returns the latest known record', () => {
    const { broadcast, fc } = make();
    broadcast.announceCaps('agent-1', ['read', 'write']);
    assert.equal(fc.box.now, 1_000_000);
    broadcast.flush();
    const rec = broadcast.view('agent-1');
    assert.equal(rec.agentId, 'agent-1');
    assert.deepEqual([...rec.capabilities], ['read', 'write']);
    assert.equal(rec.version, 1);
    assert.equal(rec.announcedAt, 1_000_000);
  });

  it('subscribe listener gets {agentId, capabilities, version} per actual announce', () => {
    const { broadcast } = make();
    const seen = [];
    broadcast.subscribe((payload) => seen.push(payload));
    broadcast.announceCaps('agent-1', ['read']);
    broadcast.announceCaps('agent-1', ['read', 'write']);
    assert.equal(seen.length, 0, 'listener not called while debounced');
    broadcast.flush();
    assert.equal(seen.length, 1);
    assert.deepEqual({ ...seen[0] }, { agentId: 'agent-1', capabilities: ['read', 'write'], version: 1 });
  });

  it('unsubscribe stops notifications and is idempotent', () => {
    const { broadcast } = make();
    let count = 0;
    const unsub = broadcast.subscribe(() => {
      count += 1;
    });
    assert.equal(unsub(), true);
    assert.equal(unsub(), false);
    broadcast.announceCaps('agent-1', ['read']);
    broadcast.flush();
    assert.equal(count, 0);
  });

  it('prune drops agents not announced within the window', () => {
    const { broadcast, fc } = make();
    broadcast.announceCaps('fresh', ['a']);
    broadcast.flush();
    fc.advance(2_000);
    broadcast.announceCaps('also-fresh', ['b']);
    broadcast.flush();
    fc.advance(4_000); // fresh is 6s old, also-fresh is 4s old
    const dropped = broadcast.prune(5_000);
    assert.deepEqual(dropped, ['fresh']);
    expectCbError(() => broadcast.view('fresh'), 'CB_NOT_FOUND');
    assert.equal(broadcast.view('also-fresh').version, 1);
  });

  it('diffCaps reports added and removed', () => {
    assert.deepEqual(diffCaps(['read', 'write'], ['write', 'exec', 'ping']), {
      added: ['exec', 'ping'],
      removed: ['read'],
    });
    assert.deepEqual(diffCaps([], ['a']), { added: ['a'], removed: [] });
    assert.deepEqual(diffCaps(['a'], []), { added: [], removed: ['a'] });
    assert.deepEqual(diffCaps(['a', 'b'], ['b', 'a']), { added: [], removed: [] });
    expectCbError(() => diffCaps('nope', []), 'CB_INVALID_CAPS');
    expectCbError(() => diffCaps([], null), 'CB_INVALID_CAPS');
  });

  it('no announce when the set is unchanged (dedupe), even with pending', () => {
    const { broadcast, fa } = make();
    broadcast.announceCaps('agent-1', ['read']);
    broadcast.flush();
    assert.equal(fa.calls.length, 1);
    // Same set re-announced: no-op, clears nothing pending because nothing pending.
    const res = broadcast.announceCaps('agent-1', ['read']);
    assert.equal(res.pending, false);
    assert.equal(res.version, 1);
    broadcast.flush();
    assert.equal(fa.calls.length, 1, 'no duplicate announce');
    // Set-equality ignores order.
    broadcast.announceCaps('agent-1', ['write', 'read', 'read']);
    broadcast.flush();
    broadcast.announceCaps('agent-1', ['read', 'write']);
    broadcast.flush();
    assert.equal(fa.calls.length, 2, 'order-only differences do not re-announce');
  });

  it('reverting to the announced set cancels a pending change', () => {
    const { broadcast, fa } = make();
    broadcast.announceCaps('agent-1', ['read']);
    broadcast.flush();
    broadcast.announceCaps('agent-1', ['read', 'write']);
    assert.equal(broadcast.pendingCount, 1);
    broadcast.announceCaps('agent-1', ['read']); // back to announced set
    assert.equal(broadcast.pendingCount, 0);
    broadcast.flush();
    assert.equal(fa.calls.length, 1, 'reverted change never announced');
  });

  it('coded-error contract: invalid inputs throw with code', () => {
    const { broadcast } = make();
    expectCbError(() => broadcast.announceCaps('', ['read']), 'CB_INVALID_AGENT_ID');
    expectCbError(() => broadcast.announceCaps(42, ['read']), 'CB_INVALID_AGENT_ID');
    expectCbError(() => broadcast.announceCaps('a', 'read'), 'CB_INVALID_CAPS');
    expectCbError(() => broadcast.announceCaps('a', ['read', 7]), 'CB_INVALID_CAPS');
    expectCbError(() => broadcast.announceCaps('a', ['read', '']), 'CB_INVALID_CAPS');
    expectCbError(() => broadcast.view('ghost'), 'CB_NOT_FOUND');
    expectCbError(() => broadcast.view(''), 'CB_INVALID_AGENT_ID');
    expectCbError(() => broadcast.subscribe('nope'), 'CB_INVALID_SUBSCRIBER');
    expectCbError(() => broadcast.prune(0), 'CB_INVALID_PRUNE');
    expectCbError(() => broadcast.prune(-5), 'CB_INVALID_PRUNE');
    expectCbError(() => createCapabilityBroadcast({ debounceMs: 0 }), 'CB_INVALID_DEBOUNCE');
    expectCbError(() => createCapabilityBroadcast({ debounceMs: NaN }), 'CB_INVALID_DEBOUNCE');
  });

  it('a throwing announce dep fails loudly with CB_ANNOUNCE_FAILED', () => {
    const fc = fakeClock();
    const broadcast = createCapabilityBroadcast({
      clock: fc.clock,
      announce: () => {
        throw new Error('transport down');
      },
    });
    broadcast.announceCaps('agent-1', ['read']);
    expectCbError(() => broadcast.flush(), 'CB_ANNOUNCE_FAILED');
    // The record still advanced (announcement logically happened); no retry loop.
    assert.equal(broadcast.view('agent-1').version, 1);
    assert.deepEqual(broadcast.flush(), [], 'nothing re-announced after failure');
  });

  it('accepts a custom debounceMs', () => {
    const { broadcast, fc, fa } = make({ debounceMs: 60_000 });
    assert.equal(broadcast.debounceMs, 60_000);
    broadcast.announceCaps('agent-1', ['read']);
    fc.advance(5_000);
    broadcast.announceCaps('agent-2', ['ping']);
    assert.equal(fa.calls.length, 0, 'default window does not apply');
    fc.advance(60_000);
    broadcast.announceCaps('agent-3', ['pong']);
    assert.equal(fa.calls.length, 2, 'both lapsed entries fired');
  });
});
