import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, validateFailurePacket } from '../scripts/spare-capacity-worker.mjs';
const identity = { source: 'fixture-revision', node: process.version, platform: process.platform, arch: process.arch, lockfile: 'fixture' };
const pass = { code: 0, reason: null, bytes: 1, logHash: 'a'.repeat(64), logName: 'fixture.log' };
function fixture(t, lane = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'spare-worker-'));
  const q = new Queue(dir, { identity, lane, lanes: 2 });
  t.after(() => { try { q.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { q, dir };
}
function baseline(q) { q.mode('dedicated'); for (let i = 0; i < 3; i++) { const j = q.next(); assert.equal(j.seed, null); q.finish(j, pass); } }
test('initially paused; persistent seed allocation resumes after completed work', t => {
  const { q, dir } = fixture(t); assert.equal(q.next(), null); baseline(q);
  const first = q.next(); q.finish(first, pass); q.close();
  const resumed = new Queue(dir); t.after(() => resumed.close());
  const next = resumed.next(); assert.equal(next.seed, first.seed + 200);
  assert.equal(next.suite, 'tests/spend-grants-property.test.js');
});
test('two laptop lanes never overlap, including spend suite seed offsets', t => {
  const a = fixture(t, 0).q, b = fixture(t, 1).q; baseline(a); baseline(b);
  const seen = new Set();
  for (let i = 0; i < 30; i++) { const j = a.next(); for (let x = 0; x < 5; x++) seen.add(j.seed + x); a.finish(j, pass); }
  for (let i = 0; i < 30; i++) { const j = b.next(); for (let x = 0; x < 5; x++) assert.equal(seen.has(j.seed + x), false); b.finish(j, pass); }
});
test('crash recovery retries same job with a new attempt, rejecting late results', t => {
  const { q } = fixture(t); baseline(q); const old = q.next(); q.recover(); const retry = q.next();
  assert.equal(retry.id, old.id); assert.equal(retry.seed, old.seed); assert.equal(retry.attempts, old.attempts + 1);
  assert.throws(() => q.finish(old, pass), /Stale/); q.finish(retry, pass);
  assert.notEqual(q.next().seed, old.seed);
});
test('mode changes are visible across connections and do not erase queued work', t => {
  const { q, dir } = fixture(t); baseline(q); const control = new Queue(dir); t.after(() => control.close());
  control.mode('paused'); assert.equal(q.next(), null); control.mode('spare'); assert.ok(q.next());
  assert.throws(() => control.mode('anything'), /Mode/);
});
test('failure stops exploration and exports source-bound reproduction metadata', t => {
  const { q } = fixture(t); baseline(q); const job = q.next();
  assert.equal(q.finish(job, { ...pass, code: 1 }), 'failed');
  assert.throws(() => q.next(), /Investigate/);
  const packet = q.failures(); assert.equal(packet.failures.length, 1);
  assert.equal(validateFailurePacket(packet, identity)[0].seed, job.seed);
  assert.throws(() => validateFailurePacket(packet, { ...identity, source: 'other' }), /Incompatible/);
  packet.failures[0].suite = '/tmp/untrusted-command'; assert.throws(() => validateFailurePacket(packet, identity), /Invalid/);
});
test('interruption queues the same seed for explicit resume, not a false failure', t => {
  const { q } = fixture(t); baseline(q); const job = q.next();
  assert.equal(q.finish(job, { ...pass, code: null, reason: 'interrupted' }), 'queued');
  assert.equal(q.summary().failures, 0); assert.equal(q.next().seed, job.seed);
});
