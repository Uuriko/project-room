import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCheckpoint, verificationPolicy } from '../scripts/release-checkpoint.mjs';
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const origins = ['https://room.example', 'https://entry.example/room'];
function reports() {
  const checks = origins.flatMap(origin => [
    ...['/api/version', '/api/version/worker'].map(path => ({ name: `version ${origin}${path}`, pass: true, status: 200, got: SHA })),
    { name: `health ${origin}/api/health`, pass: true }, { name: `ready ${origin}/api/ready`, pass: true },
    ...['/terms', '/privacy', '/'].map(path => ({ name: `page ${origin}${path}`, pass: true })),
    { name: `agent-card ${origin}/.well-known/agent-card.json`, pass: true }
  ]);
  return { strict: { exitCode: 0, report: { ok: true, sha: SHA, origin: origins[0], entry: origins[1], checks } },
    live: { exitCode: 0, report: { ok: true, origin: origins[0], liveRevision: SHA, findings: [] } } };
}
async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'release-verification-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const results = reports(); let calls = 0, reads = 0;
  const args = { output, expectedRevision: SHA, origins };
  const dependencies = {
    sourceBinding: async () => ({ revision: SHA, tree: OTHER, clean: true }),
    versionProbe: async (origin, worker) => { reads++; return { origin, httpStatus: 200, value: { status: 'ok', sourceRevision: SHA, ...(worker ? { servedBy: 'worker' } : {}) } }; },
    smokeProcess: async kind => { calls++; return results[kind]; }
  };
  return { args, dependencies, results, calls: () => calls, reads: () => reads };
}

test('verification preserves original failure bytes/digest and creates fresh repeat attempts', async t => {
  const f = await fixture(t);
  const prior = structuredClone(f.results.strict.report); prior.ok = false; prior.checks[5].pass = false;
  const raw = JSON.stringify(prior, null, 3) + '\n';
  const priorReport = join(f.args.output, 'failed-deploy.json'); await writeFile(priorReport, raw);
  const first = await verifyCheckpoint({ ...f.args, priorReport }, f.dependencies);
  const second = await verifyCheckpoint({ ...f.args, priorReport }, f.dependencies);
  assert.equal(first.state, 'verified'); assert.equal(second.state, 'verified');
  assert.notEqual(first.directory, second.directory); assert.equal(f.calls(), 4); assert.equal(f.reads(), 16);
  assert.equal(await readFile(priorReport, 'utf8'), raw);
  assert.equal(await readFile(join(first.directory, 'original-failure.json'), 'utf8'), raw);
  assert.equal(first.originalFailure.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(first.publicationPerformed, false); assert.equal(first.authenticatedProbe, 'not_performed');
  assert.equal(JSON.parse(await readFile(join(first.directory, 'receipt.json'))).state, 'verified');
});

test('wrong or dirty source refuses before public checks and records failure', async t => {
  const f = await fixture(t);
  f.dependencies.sourceBinding = async () => ({ revision: OTHER, tree: OTHER, clean: true });
  const r = await verifyCheckpoint(f.args, f.dependencies);
  assert.equal(r.state, 'failed'); assert.equal(r.error, 'source_not_pinned_clean'); assert.equal(f.reads(), 0); assert.equal(f.calls(), 0);
});

test('wrong live SHA or HTTP503 with target body refuses before smoke', async t => {
  const f = await fixture(t);
  for (const value of [{ httpStatus: 200, value: { sourceRevision: OTHER } }, { httpStatus: 503, value: { sourceRevision: SHA } }]) {
    f.dependencies.versionProbe = async () => value;
    const r = await verifyCheckpoint(f.args, f.dependencies);
    assert.equal(r.state, 'failed'); assert.equal(r.error, 'live_revision_mismatch_before');
  }
  assert.equal(f.calls(), 0);
});

test('failed strict smoke retains failure and still records live and final source observations', async t => {
  const f = await fixture(t); f.results.strict.exitCode = 1; f.results.strict.report.ok = false; f.results.strict.report.checks[0].pass = false;
  const r = await verifyCheckpoint(f.args, f.dependencies);
  assert.equal(r.state, 'failed'); assert.equal(r.stable, true); assert.equal(r.strict.exitCode, 1);
  assert.equal(f.calls(), 2); assert.equal(f.reads(), 8);
});

test('mid-run deployed or checkout revision change prevents verified receipt', async t => {
  const f = await fixture(t); let changed = false;
  const bind = f.dependencies.sourceBinding, probe = f.dependencies.versionProbe;
  f.dependencies.smokeProcess = async kind => { changed = true; return f.results[kind]; };
  f.dependencies.versionProbe = async (...args) => changed ? { httpStatus: 200, value: { sourceRevision: OTHER } } : probe(...args);
  assert.equal((await verifyCheckpoint(f.args, f.dependencies)).state, 'failed');
  changed = false; f.dependencies.versionProbe = probe;
  f.dependencies.sourceBinding = async (...args) => changed ? { revision: OTHER, tree: OTHER, clean: true } : bind(...args);
  assert.equal((await verifyCheckpoint(f.args, f.dependencies)).state, 'failed');
});

test('explicit deployed target retains main-lag failure as advisory without rewriting original result', () => {
  const r = reports(); r.live.exitCode = 1; r.live.report.ok = false;
  r.live.report.findings.push({ code: 'deploy_diverged', detail: 'rollback target', severity: 'fail' });
  const result = verificationPolicy(r.strict, r.live, { expectedRevision: SHA, origins });
  assert.equal(result.livePassed, true); assert.equal(result.warnings.length, 1);
  assert.equal(r.live.exitCode, 1); assert.equal(r.live.report.ok, false);
  r.live.report.findings.push({ code: 'discovery_invalid', severity: 'fail' });
  assert.equal(verificationPolicy(r.strict, r.live, { expectedRevision: SHA, origins }).livePassed, false);
});

test('missing checks, malformed subprocess reports and foreign prior failure cannot verify', async t => {
  const f = await fixture(t); f.results.strict.report.checks.pop();
  assert.equal((await verifyCheckpoint(f.args, f.dependencies)).state, 'failed');
  f.results.strict = { exitCode: null, error: 'invalid_or_missing_report' };
  assert.equal((await verifyCheckpoint(f.args, f.dependencies)).state, 'failed');
  const priorReport = join(f.args.output, 'wrong.json'); await writeFile(priorReport, JSON.stringify({ ok: false, sha: OTHER }));
  assert.equal((await verifyCheckpoint({ ...f.args, priorReport }, f.dependencies)).error, 'prior_failure_not_for_target');
});

test('actual verify CLI runs pinned source scripts, keeps tool identity separate, and refuses output inside source', async t => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdir, realpath } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-verify-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target'), tooling = join(root, 'tooling'), output = join(root, 'receipts');
  for (const dir of [target, tooling]) {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: dir });
  }
  const checkpoint = await readFile(fileURLToPath(new URL('../scripts/release-checkpoint.mjs', import.meta.url)), 'utf8');
  await writeFile(join(tooling, 'scripts/release-checkpoint.mjs'), checkpoint);
  const base = JSON.stringify(reports());
  const child = `import {execFileSync} from 'node:child_process';
if (process.env.SMOKE_AGENT_CARD_FETCHES) process.exit(2);
const reports=${base};const kind=process.argv[1].includes('prod-deploy')?'strict':'live';
const revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const r=reports[kind].report;if(kind==='strict'){r.sha=revision;for(const c of r.checks)if(c.got)c.got=revision;}else r.liveRevision=revision;
console.error('private diagnostic must not be retained');console.log(JSON.stringify(r));`;
  await writeFile(join(target, 'scripts/prod-deploy-smoke.mjs'), child);
  await writeFile(join(target, 'scripts/live-smoke.mjs'), child);
  for (const dir of [target, tooling]) {
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
  const preload = join(root, 'fetch.mjs');
  await writeFile(preload, `globalThis.fetch=async url=>{if(!String(url).includes('/api/version'))throw Error('unexpected request');return Response.json({status:'ok',sourceRevision:'${revision}',servedBy:'worker'})};`);
  const invoke = destination => spawnSync(process.execPath, [join(tooling, 'scripts/release-checkpoint.mjs'), '--mode', 'verify', '--expected-revision', revision,
    '--origin', origins[0], '--origin', origins[1], '--output', destination], {
    cwd: target, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, SMOKE_AGENT_CARD_FETCHES: '1' }
  });
  const result = invoke(output);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, 'verified'); assert.notEqual(receipt.sourceBefore.revision, receipt.toolingBefore.revision);
  assert.equal(result.stdout.includes('private diagnostic'), false);
  const inside = invoke(join(target, 'receipts'));
  assert.equal(inside.status, 1); assert.equal(JSON.parse(inside.stdout).error, 'source_not_pinned_clean');
});
