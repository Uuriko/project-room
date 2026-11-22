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
  const schema = revision => ({ version: 42, revision, blob: 'd'.repeat(40), replyContractBlob: '9'.repeat(40), messageReaderBlob: '8'.repeat(40), oauthClientContractBlob: '7'.repeat(40), oauthProviderBlob: '6'.repeat(40), definitions: 'same exact definitions' });
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

// OAuth scope/grant changes can reject persisted grants without changing the
// storage floor. Exercise the recovery owner with exact Git source proofs.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { schemaAt, automaticRollbackDecision } from '../scripts/deploy-recovery.mjs';

test('OAuth recovery proofs refuse changed or absent contracts before any rollback mutation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'server')); mkdirSync(join(dir, 'src'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']); git(['config', 'user.name', 'Synthetic recovery test']);
  git(['config', 'user.email', 'recovery@example.invalid']);
  const commit = message => { git(['add', '.']); git(['commit', '--quiet', '-m', message]); return git(['rev-parse', 'HEAD']); };
  const contractPath = 'server/oauth-client-contract.mjs', providerPath = 'server/oauth-provider.mjs';
  const sources = {
    [contractPath]: 'export const OAUTH_SCOPES = ["rooms:read"];\nthrow Error("source must not execute");\n',
    [providerPath]: 'export const GRANT_READER = 1;\nthrow Error("source must not execute");\n',
  };
  writeFileSync(join(dir, 'server/writer-fence.mjs'), 'export const STORE_SCHEMA_VERSION = 46;\n');
  writeFileSync(join(dir, 'src/reply-requests.js'), 'export const REPLY_READER = 1;\n');
  writeFileSync(join(dir, 'server/current-room-repository.mjs'), 'export const MESSAGE_READER = 1;\n');
  for (const [path, source] of Object.entries(sources)) writeFileSync(join(dir, path), source);
  const oldRevision = commit('old OAuth readers'), oldProof = schemaAt(oldRevision, git);
  const old = '11111111-1111-1111-1111-111111111111', fresh = '22222222-2222-2222-2222-222222222222';
  const recover = async (prior, next, eligible) => {
    const previous = { known: true, versionId: old, sourceRevision: prior.revision, codeSchemaVersion: 46, schemaSource: prior };
    const rolled = new Set(); let sourceReads = 0;
    const report = await recoverWorkers({ targetSha: next.revision, candidateCodeSchemaVersion: 46, candidateSchemaSource: next, prod: previous, entry: previous }, { prod: true, entry: true }, {
      status: async name => ({ versions: [{ version_id: rolled.has(name) ? old : fresh, percentage: 100 }] }),
      rollback: async name => { assert.equal(rolled.has(name), false); rolled.add(name); },
      readVersion: async () => { sourceReads++; return { status: 'ok', servedBy: 'worker', sourceRevision: prior.revision }; },
      readDurableVersion: async () => { sourceReads++; return { status: 'ok', servedBy: 'durable-object', sourceRevision: prior.revision }; },
    });
    assert.equal(report.status, eligible ? 'ROLLBACK VERIFIED' : 'ROLL FORWARD REQUIRED');
    assert.equal(rolled.size, eligible ? 2 : 0, 'incompatible OAuth source must never invoke rollback');
    if (!eligible) assert.equal(sourceReads, 0, 'unattempted rollback must not claim source convergence');
    for (const row of Object.values(report.workers)) {
      assert.equal(row.rollbackAttempted, eligible);
      assert.equal(row.disposition, eligible ? 'rollback_verified' : 'roll_forward_required');
      if (!eligible) assert.match(row.reason, /OAuth/);
    }
  };
  await t.test('same exact source remains eligible', () => recover(oldProof, oldProof, true));
  for (const [path, field] of [[contractPath, 'oauthClientContractBlob'], [providerPath, 'oauthProviderBlob']]) {
    await t.test(`${path}: changed source, missing source, and unchanged-source control`, async () => {
      writeFileSync(join(dir, path), sources[path].replace(path === contractPath ? '"rooms:read"' : '= 1', path === contractPath ? '"rooms:read", "files:read", "files:write"' : '= 2'));
      const changed = schemaAt(commit('changed ' + field), git);
      assert.equal(changed.version, oldProof.version);
      assert.equal(changed.blob, oldProof.blob);
      assert.equal(changed.replyContractBlob, oldProof.replyContractBlob);
      assert.equal(changed.messageReaderBlob, oldProof.messageReaderBlob);
      await recover(oldProof, changed, false);
      await recover(changed, oldProof, false);
      assert.equal(changed[field], git(['rev-parse', `${changed.revision}:${path}`]));
      assert.ok(changed.definitions.split('\n').includes(`${path}@${changed[field]}`));
      rmSync(join(dir, path));
      const missing = schemaAt(commit('missing ' + field), git);
      assert.equal(missing.version, 46, 'manual schema proof remains available');
      assert.equal(missing[field], null);
      await recover(oldProof, missing, false);
      await recover(missing, oldProof, false);
      await recover(missing, missing, false);
      writeFileSync(join(dir, path), sources[path]);
      const restored = schemaAt(commit('restore ' + field), git);
      await recover(oldProof, restored, true);
    });
    await t.test(`${field}: absent or malformed explicit evidence never inherits eligibility from matching definitions`, async () => {
      for (const invalid of [undefined, null, 'unknown', 'a'.repeat(39)]) {
        const incomplete = { ...oldProof, [field]: invalid };
        await recover(oldProof, incomplete, false);
        await recover(incomplete, oldProof, false);
      }
      const badGit = args => args[0] === 'rev-parse' && args[1].endsWith(':' + path) ? 'not-a-blob' : git(args);
      const malformed = schemaAt(oldRevision, badGit);
      assert.equal(malformed.version, 46);
      assert.equal(malformed[field], null);
      assert.equal(automaticRollbackDecision({ known: true, versionId: old, sourceRevision: oldRevision, codeSchemaVersion: 46, schemaSource: oldProof }, 46, malformed).eligible, false);
    });
  }
});
