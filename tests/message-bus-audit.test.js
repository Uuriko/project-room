/**
 * message-bus-audit.test.js — tests for the tamper-evident message bus audit log.
 *
 * Covers: hash-linked appends, independent hash recomputation, verify() on a
 * valid chain, tamper detection at the right seq (modified entry, seq gap,
 * broken prevHash link), get/range, frozen entries, importChain accept/reject,
 * stats, deterministic hashing under a fake clock, and the coded-error
 * contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createMessageBusAudit,
  verifyChain,
  GENESIS_PREV_HASH,
} from '../src/message-bus-audit.mjs';

/** Controllable clock: { now, clock(), advance(ms) }. */
function fakeClock(start = 1_700_000_000_000) {
  const box = { now: start };
  return {
    box,
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

/** Independent SHA-256 over the canonical entry payload (mirrors the module). */
function expectedHash({ seq, at, actor, action, detail, prevHash }) {
  return createHash('sha256')
    .update(JSON.stringify({ seq, at, actor, action, detail, prevHash }), 'utf8')
    .digest('hex');
}

function makeLog(start) {
  const fc = fakeClock(start);
  return { log: createMessageBusAudit({ clock: fc.clock }), fc };
}

/** Append three deterministic entries; returns them. */
function seedThree(log) {
  const e1 = log.append('bus', 'message.sent', { id: 'm1' });
  const e2 = log.append('bus', 'message.delivered', { id: 'm1' });
  const e3 = log.append('moderator', 'message.redacted', { id: 'm1', reason: 'spam' });
  return [e1, e2, e3];
}

function expectAuditError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('message-bus-audit', () => {
  it('appends hash-linked entries starting from GENESIS', () => {
    const { log } = makeLog();
    const [e1, e2, e3] = seedThree(log);

    assert.equal(e1.seq, 1);
    assert.equal(e1.prevHash, GENESIS_PREV_HASH);
    assert.equal(e2.seq, 2);
    assert.equal(e2.prevHash, e1.hash);
    assert.equal(e3.seq, 3);
    assert.equal(e3.prevHash, e2.hash);

    for (const e of [e1, e2, e3]) {
      assert.match(e.hash, /^[0-9a-f]{64}$/, 'hash is sha256 hex');
      assert.equal(e.at, 1_700_000_000_000);
    }
  });

  it('hashes match an independent SHA-256 recomputation', () => {
    const { log, fc } = makeLog();
    fc.advance(42);
    const e = log.append('agent-7', 'claim.taken', { claim: 'B035-2' });
    assert.equal(
      e.hash,
      expectedHash({
        seq: 1,
        at: 1_700_000_000_042,
        actor: 'agent-7',
        action: 'claim.taken',
        detail: { claim: 'B035-2' },
        prevHash: GENESIS_PREV_HASH,
      }),
    );
    // Omitted detail is hashed as null.
    const bare = log.append('agent-7', 'heartbeat');
    assert.equal(bare.detail, null);
    assert.equal(
      bare.hash,
      expectedHash({
        seq: 2,
        at: 1_700_000_000_042,
        actor: 'agent-7',
        action: 'heartbeat',
        detail: null,
        prevHash: e.hash,
      }),
    );
  });

  it('same inputs + same clock produce identical hashes across instances', () => {
    const a = makeLog();
    const b = makeLog();
    seedThree(a.log);
    seedThree(b.log);
    assert.deepEqual(
      a.log.export().map((e) => e.hash),
      b.log.export().map((e) => e.hash),
    );
  });

  it('verify() returns ok on a valid chain (and on an empty log)', () => {
    const { log } = makeLog();
    assert.deepEqual(log.verify(), { ok: true });
    seedThree(log);
    assert.deepEqual(log.verify(), { ok: true });
    assert.deepEqual(verifyChain(log.export()), { ok: true });
  });

  it('verify detects a modified entry at the right seq', () => {
    const { log } = makeLog();
    seedThree(log);
    const tampered = log.export();
    tampered[1].action = 'message.forged'; // hash left stale
    assert.deepEqual(verifyChain(tampered), { ok: false, brokenAt: 2 });

    const tamperedDetail = log.export();
    tamperedDetail[2].detail.reason = 'censorship';
    assert.deepEqual(verifyChain(tamperedDetail), { ok: false, brokenAt: 3 });

    const tamperedHash = log.export();
    tamperedHash[0].hash = '0'.repeat(64);
    assert.deepEqual(verifyChain(tamperedHash), { ok: false, brokenAt: 1 });
  });

  it('verify detects a sequence gap at the right seq', () => {
    const { log } = makeLog();
    seedThree(log);
    const gapped = log.export().filter((e) => e.seq !== 2); // seqs 1, 3
    assert.deepEqual(verifyChain(gapped), { ok: false, brokenAt: 3 });
  });

  it('verify detects a broken prevHash link at the right seq', () => {
    const { log } = makeLog();
    seedThree(log);
    const relinked = log.export();
    relinked[2].prevHash = GENESIS_PREV_HASH;
    assert.deepEqual(verifyChain(relinked), { ok: false, brokenAt: 3 });
  });

  it('verifyChain rejects a non-array with MBA_INVALID_CHAIN', () => {
    expectAuditError(() => verifyChain('nope'), 'MBA_INVALID_CHAIN');
    expectAuditError(() => verifyChain(null), 'MBA_INVALID_CHAIN');
  });

  it('get returns entries; unknown seq throws MBA_NOT_FOUND', () => {
    const { log } = makeLog();
    const [e1, e2] = seedThree(log);
    assert.equal(log.get(1), e1);
    assert.equal(log.get(2).action, 'message.delivered');
    assert.equal(e2.seq, 2);
    expectAuditError(() => log.get(99), 'MBA_NOT_FOUND');
  });

  it('get with a non-positive-integer seq throws MBA_INVALID_SEQ', () => {
    const { log } = makeLog();
    seedThree(log);
    expectAuditError(() => log.get(0), 'MBA_INVALID_SEQ');
    expectAuditError(() => log.get(-1), 'MBA_INVALID_SEQ');
    expectAuditError(() => log.get(1.5), 'MBA_INVALID_SEQ');
    expectAuditError(() => log.get('1'), 'MBA_INVALID_SEQ');
  });

  it('range returns the inclusive slice', () => {
    const { log } = makeLog();
    seedThree(log);
    const slice = log.range(2, 3);
    assert.equal(slice.length, 2);
    assert.deepEqual(
      slice.map((e) => e.seq),
      [2, 3],
    );
    assert.deepEqual(
      log.range(1, 1).map((e) => e.seq),
      [1],
    );
    // Clamps at the tail rather than throwing.
    assert.equal(log.range(2, 99).length, 2);
  });

  it('range rejects bad bounds with MBA_INVALID_RANGE', () => {
    const { log } = makeLog();
    seedThree(log);
    expectAuditError(() => log.range(3, 2), 'MBA_INVALID_RANGE');
    expectAuditError(() => log.range(0, 2), 'MBA_INVALID_RANGE');
    expectAuditError(() => log.range(1.5, 2), 'MBA_INVALID_RANGE');
  });

  it('appended entries are deeply frozen', () => {
    const { log } = makeLog();
    const e = log.append('bus', 'message.sent', { id: 'm1', tags: ['a'] });
    assert.ok(Object.isFrozen(e));
    assert.ok(Object.isFrozen(e.detail));
    assert.ok(Object.isFrozen(e.detail.tags));
    assert.throws(() => {
      e.action = 'forged';
    }, TypeError);
    assert.throws(() => {
      e.detail.id = 'm2';
    }, TypeError);
    assert.throws(() => {
      e.detail.tags.push('b');
    }, TypeError);
  });

  it('append validates actor/action/detail with MBA_INVALID_ENTRY', () => {
    const { log } = makeLog();
    expectAuditError(() => log.append('', 'x'), 'MBA_INVALID_ENTRY');
    expectAuditError(() => log.append('bus', ''), 'MBA_INVALID_ENTRY');
    expectAuditError(() => log.append(42, 'x'), 'MBA_INVALID_ENTRY');
    expectAuditError(() => log.append('bus', null), 'MBA_INVALID_ENTRY');
    const circular = {};
    circular.self = circular;
    expectAuditError(() => log.append('bus', 'x', circular), 'MBA_INVALID_ENTRY');
    // Failed appends do not advance the chain.
    assert.equal(log.stats().entries, 0);
  });

  it('export returns a deep copy that cannot mutate the log', () => {
    const { log } = makeLog();
    seedThree(log);
    const out = log.export();
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 3);
    out[0].action = 'forged';
    out[1].detail.id = 'mX';
    out.pop();
    assert.equal(log.get(1).action, 'message.sent');
    assert.equal(log.get(2).detail.id, 'm1');
    assert.deepEqual(log.verify(), { ok: true });
  });

  it('importChain accepts a valid exported chain and appends continue it', () => {
    const a = makeLog();
    seedThree(a.log);
    const b = makeLog(1_800_000_000_000);
    const res = b.log.importChain(a.log.export());
    assert.equal(res.entries, 3);
    assert.deepEqual(b.log.verify(), { ok: true });
    assert.equal(b.log.get(2).hash, a.log.get(2).hash);

    const next = b.log.append('bus', 'message.sent', { id: 'm2' });
    assert.equal(next.seq, 4);
    assert.equal(next.prevHash, a.log.get(3).hash);
    assert.deepEqual(b.log.verify(), { ok: true });
  });

  it('importChain accepts an empty chain (resets the log)', () => {
    const { log } = makeLog();
    seedThree(log);
    log.importChain([]);
    assert.deepEqual(log.stats(), { entries: 0, bytesApprox: 0, firstSeq: null, lastSeq: null });
    assert.equal(log.append('bus', 'x').seq, 1);
  });

  it('importChain rejects a corrupt chain with MBA_CORRUPT_CHAIN naming the seq', () => {
    const a = makeLog();
    seedThree(a.log);
    const b = makeLog();
    b.log.append('bus', 'existing'); // must survive the failed import (atomic)

    const tampered = a.log.export();
    tampered[1].action = 'message.forged';
    assert.throws(
      () => b.log.importChain(tampered),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.code, 'MBA_CORRUPT_CHAIN');
        assert.equal(err.detail.seq, 2);
        return true;
      },
    );
    // Failed import left b untouched.
    assert.equal(b.log.stats().entries, 1);
    assert.equal(b.log.get(1).action, 'existing');
    assert.deepEqual(b.log.verify(), { ok: true });
  });

  it('importChain rejects malformed input with MBA_INVALID_CHAIN', () => {
    const { log } = makeLog();
    expectAuditError(() => log.importChain('nope'), 'MBA_INVALID_CHAIN');
    expectAuditError(() => log.importChain([null]), 'MBA_INVALID_CHAIN');
    expectAuditError(() => log.importChain([{ seq: 1 }]), 'MBA_INVALID_CHAIN');
    const badHash = { seq: 1, at: 1, actor: 'a', action: 'b', detail: null, prevHash: 'x', hash: 'zz' };
    expectAuditError(() => log.importChain([badHash]), 'MBA_INVALID_CHAIN');
    // A well-formed but non-genesis chain is corrupt, not malformed.
    const other = makeLog();
    seedThree(other.log);
    const [, e2, e3] = other.log.export(); // seqs 2,3 — gap at the head
    assert.throws(() => log.importChain([e2, e3]), (err) => err.code === 'MBA_CORRUPT_CHAIN');
  });

  it('stats reports entries, bytesApprox, firstSeq, lastSeq', () => {
    const { log } = makeLog();
    assert.deepEqual(log.stats(), { entries: 0, bytesApprox: 0, firstSeq: null, lastSeq: null });
    seedThree(log);
    const s = log.stats();
    assert.equal(s.entries, 3);
    assert.equal(s.firstSeq, 1);
    assert.equal(s.lastSeq, 3);
    assert.ok(s.bytesApprox > 0);
    assert.ok(Number.isInteger(s.bytesApprox));
  });

  it('exposes a logId (injectable via deps.id)', () => {
    const { log } = makeLog();
    assert.equal(typeof log.logId, 'string');
    assert.ok(log.logId.length > 0);
    const custom = createMessageBusAudit({ id: () => 'log-42' });
    assert.equal(custom.logId, 'log-42');
  });

  it('every failure carries a coded Error (contract sweep)', () => {
    const { log } = makeLog();
    const cases = [
      [() => log.append('', 'x'), 'MBA_INVALID_ENTRY'],
      [() => log.get(7), 'MBA_NOT_FOUND'],
      [() => log.get(0), 'MBA_INVALID_SEQ'],
      [() => log.range(2, 1), 'MBA_INVALID_RANGE'],
      [() => log.importChain({}), 'MBA_INVALID_CHAIN'],
      [() => log.importChain([{ seq: 1, at: 1, actor: 'a', action: 'b', detail: null, prevHash: GENESIS_PREV_HASH, hash: 'f'.repeat(64) }]), 'MBA_CORRUPT_CHAIN'],
      [() => verifyChain(12), 'MBA_INVALID_CHAIN'],
    ];
    for (const [fn, code] of cases) expectAuditError(fn, code);
  });
});
