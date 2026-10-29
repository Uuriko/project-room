import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { timeoutOnlyEvidence } from '../scripts/readiness-recovery-hold.mjs';
import { heldRecovery, recoveryDescription } from '../scripts/deploy-recovery.mjs';
const sha = 'a'.repeat(40), origin = 'https://canonical.example', entry = 'https://entry.example/room';
const fixture = () => ({ ok: false, sha, origin, entry, checks: [origin, entry].flatMap(door => [
  ...['/api/version', '/api/version/worker'].map(path => ({ name: `version ${door}${path}`, pass: true, status: 200, got: sha })),
  { name: `health ${door}/api/health`, pass: true, status: 200, body: 'ok' },
  ...['/terms', '/privacy', '/'].map(path => ({ name: `page ${door}${path}`, pass: true, status: 200 })),
  { name: `agent-card ${door}/.well-known/agent-card.json`, pass: true, converged: true, fetches: 10, attempts: 10, failures: [], failureCount: 0 },
  { name: `ready ${door}/api/ready`, pass: false, status: 503, body: 'degraded', emailVerification: 'unknown', emailVerificationScope: 'unknown', do: { status: 'timeout', timeoutMs: 1000 } },
]) });
const context = raw => ({ sha, origin, entry, digest: createHash('sha256').update(raw).digest('hex'),
  prodOutcome: 'success', entryOutcome: 'success', smokeOutcome: 'failure' });
test('only complete digest-bound timeout evidence holds recovery, never calls it healthy', () => {
  const raw = JSON.stringify(fixture()), options = context(raw);
  assert.equal(timeoutOnlyEvidence(raw, options), true);
  const held = heldRecovery({ targetSha: sha, candidateCodeSchemaVersion: 42 }, raw, options);
  assert.equal(held.releaseFailed, true);
  const description = recoveryDescription(held);
  assert.match(description, /RECOVERY HELD — MANUAL DIAGNOSIS REQUIRED/);
  assert.match(description, /prod: recovery_held/);
  assert.match(description, /entry: recovery_held/);
  assert.doesNotMatch(description, /ROLLBACK VERIFIED/);
  assert.match(held.status, /RECOVERY HELD/);
  assert.ok(Object.values(held.workers).every(worker => worker.rollbackAttempted === false));
  assert.equal(heldRecovery({ targetSha: sha }, raw, { ...options, prodOutcome: 'failure' }), null);
  assert.equal(heldRecovery({ targetSha: sha }, raw, { ...options, smokeOutcome: 'success' }), null);
  assert.equal(timeoutOnlyEvidence(raw + ' ', options), false);
  assert.equal(timeoutOnlyEvidence(raw, { ...options, sha: 'b'.repeat(40) }), false);
  assert.equal(timeoutOnlyEvidence(raw, { ...options, entry: origin }), false);
  assert.equal(timeoutOnlyEvidence('{', context('{')), false);
});
test('malformed, incomplete, integrity, readiness-policy and other failures keep existing recovery policy', () => {
  for (const change of [r => r.checks.pop(), r => r.checks[0] = r.checks[1],
    r => r.checks[0].got = 'b'.repeat(40), r => r.checks[0].status = 503,
    r => r.checks[2].pass = false, r => r.checks[3].status = 500,
    r => r.checks[6].failures.push('invalid signature'), r => r.checks[6].fetches = 1,
    r => r.checks[6].converged = false, r => r.checks[7].do.status = 'error',
    r => r.checks[7].do.timeoutMs = 5000, r => r.checks[7].emailVerification = 'relaxed-no-mailer',
    r => r.checks[7].emailVerificationScope = 'worker', r => r.checks[7].transport = 'fetch_timeout']) {
    const report = fixture(); change(report); const raw = JSON.stringify(report);
    assert.equal(timeoutOnlyEvidence(raw, context(raw)), false);
  }
});
test('actual recovery CLI writes held artifact and exits failed without any rollback executable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-hold-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const raw = JSON.stringify(fixture()), options = context(raw);
  const snapshot = join(directory, 'pre.json'), smoke = join(directory, 'smoke.json'), output = join(directory, 'recovery.json');
  writeFileSync(snapshot, JSON.stringify({ targetSha: sha, candidateCodeSchemaVersion: 42 }));
  writeFileSync(smoke, raw);
  const result = spawnSync(process.execPath, ['scripts/deploy-recovery.mjs', 'recover', snapshot, output], {
    encoding: 'utf8', env: { ...process.env, PATH: directory, GITHUB_STEP_SUMMARY: '',
      SHA: sha, PROD_ORIGIN: origin, ENTRY_ORIGIN: entry, PROD_OUTCOME: 'success', ENTRY_OUTCOME: 'success',
      SMOKE_OUTCOME: 'failure', SMOKE_REPORT_PATH: smoke, SMOKE_REPORT_SHA256: options.digest },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RECOVERY HELD/);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.smokeSha256, options.digest);
  assert.equal(report.releaseFailed, true);
  assert.equal(readFileSync(smoke, 'utf8'), raw);
});
