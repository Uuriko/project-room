import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverWorkers, verifyRollbackSources } from '../scripts/deploy-recovery.mjs';
const prod = 'a'.repeat(40), entry = 'e'.repeat(40), candidate = 'b'.repeat(40);
const expected = { prod: { edge: prod, durable: prod }, entry: { edge: entry, durable: prod } };
const edge = async name => ({ status: 'ok', servedBy: 'worker', sourceRevision: expected[name].edge });
const durable = revision => ({ status: 'ok', sourceRevision: revision });
function clock() { let time = 0; return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; } }; }
for (const kind of ['candidate', 'missing', 'error', 'worker', 'unknown-marker']) test(`rollback source proof refuses ${kind} DO evidence at the bounded deadline`, async () => {
  const c = clock();
  const proof = await verifyRollbackSources(expected, { ...c, timeoutMs: 420000, pollMs: 50000, readVersion: edge,
    readDurableVersion: async () => { if (kind === 'error') throw new Error('unavailable'); return kind === 'missing' ? {} : { ...durable(kind === 'candidate' ? candidate : prod), ...(['worker', 'unknown-marker'].includes(kind) ? { servedBy: kind } : {}) }; } });
  assert.equal(proof.verified, false); assert.equal(proof.elapsedMs, 420000); assert.equal(proof.attempts, 9);
});
test('later DO adoption verifies both doors using shared prod source even when entry source differs', async () => {
  const c = clock(); const proof = await verifyRollbackSources(expected, { ...c, pollMs: 50000, readVersion: edge,
    readDurableVersion: async () => durable(c.now() >= 300000 ? prod : candidate) });
  assert.equal(proof.verified, true); assert.equal(proof.elapsedMs, 300000); assert.equal(proof.attempts, 7);
  assert.equal(proof.doors.entry.edgeRevision, entry); assert.equal(proof.doors.entry.durableRevision, prod);
});
test('a successful HTTP completion after the total deadline cannot verify rollback', async () => {
  const c = clock(); const proof = await verifyRollbackSources({ prod: expected.prod }, { ...c, timeoutMs: 100, readVersion: edge,
    readDurableVersion: async () => { c.advance(101); return durable(prod); } });
  assert.equal(proof.verified, false); assert.equal(proof.attempts, 1);
});
test('a reader that never resolves is bounded and receives cancellation', async () => {
  let aborted = false;
  const proof = await verifyRollbackSources({ prod: expected.prod }, { timeoutMs: 20, readVersion: edge,
    readDurableVersion: (name, { signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } });
  assert.equal(proof.verified, false); assert.equal(aborted, true); assert.ok(proof.elapsedMs >= 19 && proof.elapsedMs < 1000);
});
test('edge allocation rollback alone never produces rollback_verified and rollback commands run once', async () => {
  const old = '11111111-1111-1111-1111-111111111111', fresh = '22222222-2222-2222-2222-222222222222';
  const schema = revision => ({ version: 42, revision, blob: 'd'.repeat(40), definitions: 'same exact definitions' });
  const previous = sourceRevision => ({ known: true, versionId: old, sourceRevision, codeSchemaVersion: 42, schemaSource: schema(sourceRevision) });
  const snapshot = { targetSha: candidate, candidateCodeSchemaVersion: 42, candidateSchemaSource: schema(candidate), prod: previous(prod), entry: previous(entry) };
  const rolled = new Set(), c = clock();
  const report = await recoverWorkers(snapshot, { prod: true, entry: true }, {
    status: async name => ({ versions: [{ version_id: rolled.has(name) ? old : fresh, percentage: 100 }] }),
    rollback: async name => { assert.equal(rolled.has(name), false); rolled.add(name); },
    readVersion: edge, readDurableVersion: async () => durable(candidate), convergence: { ...c, timeoutMs: 100, pollMs: 50 }
  });
  assert.equal(report.status, 'ROLLBACK NOT VERIFIED'); assert.equal(rolled.size, 2);
  for (const row of Object.values(report.workers)) { assert.equal(row.disposition, 'rollback_unverified'); assert.equal(row.sourceConvergence.verified, false); }
});
