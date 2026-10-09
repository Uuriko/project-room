// Extended coalescing for high-frequency claim chatter: the DEFAULT claim
// path emits one room event per write, so a worker posting ten rapid updates
// floods the tail, the digest and every wake feed. coalesceUpdateLog merges
// consecutive same-claim updates inside a window into one entry, preserving
// first/last timestamps and every note in order; shouldEmitHeartbeat gives a
// cheap stale-claim keepalive decision. Pure functions, no store coupling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceUpdateLog, shouldEmitHeartbeat } from '../server/event-coalesce.mjs';

const makeEntry = (claimId, note, at) => ({ claimId, action: 'updated', note, at });

test('10 rapid updates merge into 1 entry with all notes preserved in order', () => {
  const entries = Array.from({ length: 10 }, (_, i) =>
    makeEntry('lane-a', `note-${i}`, 1_000_000 + i * 100));
  const result = coalesceUpdateLog(entries, { windowMs: 60_000 });
  assert.equal(result.length, 1);
  assert.equal(result[0].claimId, 'lane-a');
  assert.equal(result[0].action, 'updated');
  assert.deepEqual(result[0].notes, entries.map(e => e.note));
  assert.equal(result[0].firstAt, entries[0].at);
  assert.equal(result[0].lastAt, entries[entries.length - 1].at);
  assert.equal(result[0].updateCount, 10);
});

test('updates outside the window are not merged', () => {
  const entries = [
    makeEntry('lane-a', 'early', 1_000_000),
    makeEntry('lane-a', 'late', 1_000_000 + 120_001)
  ];
  const result = coalesceUpdateLog(entries, { windowMs: 60_000 });
  assert.equal(result.length, 2);
  assert.equal(result[0].notes[0], 'early');
  assert.equal(result[1].notes[0], 'late');
});

test('different claims are never merged, even inside the window', () => {
  const entries = [
    makeEntry('lane-a', 'a-one', 1_000_000),
    makeEntry('lane-b', 'b-one', 1_000_000 + 50),
    makeEntry('lane-a', 'a-two', 1_000_000 + 100)
  ];
  const result = coalesceUpdateLog(entries, { windowMs: 60_000 });
  // A different claim breaks the consecutive run; the two lane-a updates are
  // each merged alone, and none of lane-a's notes land in lane-b's entry.
  assert.equal(result.length, 3);
  const a = result.filter(r => r.claimId === 'lane-a');
  const b = result.find(r => r.claimId === 'lane-b');
  assert.equal(a.length, 2);
  assert.deepEqual(a.map(g => g.notes).flat(), ['a-one', 'a-two']);
  assert.deepEqual(b.notes, ['b-one']);
});

test('heartbeat suppressed within the interval, emitted after it', () => {
  assert.equal(shouldEmitHeartbeat(1_000_000, 1_000_000 + 30_000, { intervalMs: 60_000 }), false);
  assert.equal(shouldEmitHeartbeat(1_000_000, 1_000_000 + 60_000, { intervalMs: 60_000 }), true);
  assert.equal(shouldEmitHeartbeat(null, 2_000_000, { intervalMs: 60_000 }), true);
});
