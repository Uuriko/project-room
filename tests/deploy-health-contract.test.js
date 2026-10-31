import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentHealth, readDeploymentHealth } from '../scripts/prod-deploy-smoke.mjs';
const now = Date.now();
function fixture() {
  return { health: { status: 200, json: { status: 'ok', liveness: 'ok', jobs: { status: 'ok' } } }, jobs: { status: 200, json: { schema: 'room.job-health/1', status: 'ok', generatedAt: new Date(now).toISOString(), jobs: [
    { name: 'room-backup', required: true, status: 'ok', stale: false, consecutiveFailures: 0 },
    { name: 'integrity', required: false, status: 'ok', stale: false, consecutiveFailures: 0 }
  ] } } };
}
function check(f) { return deploymentHealth(f.health, f.jobs, now); }
function rateLimit(f) {
  f.health.json.status = f.health.json.jobs.status = f.jobs.json.status = 'degraded';
  f.jobs.json.jobs.push({ name: 'claim-prs', required: false, status: 'degraded', stale: false, consecutiveFailures: 0, degraded: 'github_rate_limited', lastSummary: { rateLimited: true } });
}
test('healthy and explicit optional GitHub wait qualify without hiding degradation', () => {
  const f = fixture(); assert.equal(check(f).pass, true);
  rateLimit(f); const result = check(f); assert.equal(result.pass, true);
  assert.equal(result.body, 'degraded'); assert.deepEqual(result.degradedJobs, [{ name: 'claim-prs', reason: 'github_rate_limited' }]);
});
for (const [name, mutate] of Object.entries({
  'lying healthy summary': f => { rateLimit(f); f.health.json.status = 'ok'; },
  'lying jobs summary': f => { rateLimit(f); f.jobs.json.status = 'ok'; },
  'partial new envelope': f => { delete f.health.json.liveness; },
  'unknown probe': f => { f.health.json.jobs.status = 'unknown'; },
  'timeout probe': f => { f.health.json.jobs.status = 'timeout'; },
  'error probe': f => { f.health.json.jobs.status = 'error'; },
  'dead liveness': f => { f.health.json.liveness = 'error'; },
  'unavailable HTTP': f => { f.health.status = 503; },
  'malformed jobs': f => { f.jobs.json.jobs = [{}]; },
  'wrong job schema': f => { f.jobs.json.schema = 'different'; },
  'stale snapshot': f => { f.jobs.json.generatedAt = new Date(now - 60001).toISOString(); },
  'required backup missing': f => { f.jobs.json.jobs.shift(); },
  'backup required marker removed': f => { f.jobs.json.jobs[0].required = false; },
  'required backup disabled': f => { f.jobs.json.jobs[0].status = 'disabled'; },
  'required backup failing': f => { f.jobs.json.jobs[0].status = 'failing'; },
  'required backup stale': f => { f.jobs.json.jobs[0].status = 'stale'; },
  'hidden backup failure': f => { f.jobs.json.jobs[0].consecutiveFailures = 1; },
  'integrity failing': f => { f.jobs.json.jobs[1].status = 'failing'; f.jobs.json.jobs[1].consecutiveFailures = 1; },
  'integrity stale': f => { f.jobs.json.jobs[1].stale = true; },
  'unsupported callback degradation': f => { rateLimit(f); f.jobs.json.jobs[2].degraded = 'native_callback_failed'; },
  'rate-limit claim missing evidence': f => { rateLimit(f); delete f.jobs.json.jobs[2].lastSummary; },
  'duplicate required job': f => { f.jobs.json.jobs.push({ ...f.jobs.json.jobs[0] }); },
  'job transport failure': f => { f.jobs.status = 503; },
})) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.equal(check(f).pass, false); });
test('legacy rollback liveness still independently checks required jobs', () => {
  const f = fixture(); f.health.json = { status: 'ok' }; assert.equal(check(f).pass, true);
  f.jobs.json.jobs[0].status = 'failing'; assert.equal(check(f).pass, false);
});
test('reports only fixed safe diagnostics, not arbitrary error or response fields', () => {
  const f = fixture(); rateLimit(f); f.jobs.json.jobs[2].name = 'secret-untrusted';
  f.jobs.json.jobs[2].lastError = 'private callback path and bearer';
  const result = check(f); assert.equal(result.pass, true);
  assert.equal(result.degradedJobs[0].name, 'job');
  assert.doesNotMatch(JSON.stringify(result), /secret-untrusted|private callback|bearer/);
});


test('a genuine ok/rate-limit snapshot transition is reread as a whole pair', async () => {
  const healthy = fixture(), limited = fixture(); rateLimit(limited);
  let healthReads = 0, jobReads = 0;
  const result = await readDeploymentHealth(async () => (++healthReads === 1 ? healthy.health : limited.health), async () => { jobReads++; return limited.jobs; }, () => now);
  assert.equal(result.pass, true); assert.equal(result.attempts, 2);
  assert.equal(healthReads, 2); assert.equal(jobReads, 2); assert.equal(result.body, 'degraded');
});
test('persistent cross-snapshot mismatch remains rejected after three complete pairs', async () => {
  const healthy = fixture(), limited = fixture(); rateLimit(limited);
  let reads = 0;
  const result = await readDeploymentHealth(async () => healthy.health, async () => { reads++; return limited.jobs; }, () => now);
  assert.equal(result.pass, false); assert.equal(result.reason, 'inconsistent_health'); assert.equal(reads, 3);
});
test('lying summaries and required failure never use transition retries', async () => {
  for (const kind of ['lying', 'required']) {
    const f = fixture();
    if (kind === 'lying') { rateLimit(f); f.health.json.status = 'ok'; }
    else { f.jobs.json.jobs[0].status = 'failing'; }
    let reads = 0;
    const result = await readDeploymentHealth(async () => f.health, async () => { reads++; return f.jobs; }, () => now);
    assert.equal(result.pass, false); assert.equal(reads, 1);
  }
});

for (const status of ['stale', 'failing', 'timeout', 'error', 'private callback URL or credential']) {
  test(`health receipt retains sanitized probe state: ${status}`, () => {
    const f = fixture(); f.health.json.status = 'degraded'; f.health.json.jobs.status = status;
    const result = check(f);
    assert.equal(result.pass, false); assert.equal(result.reason, 'inconsistent_health');
    assert.equal(result.jobsStatus, 'ok');
    assert.equal(result.healthJobsStatus, status.startsWith('private') ? 'unknown' : status);
    assert.equal(JSON.stringify(result).includes('private callback'), false);
  });
}
