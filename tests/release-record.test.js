import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { composeReleaseRecord } from '../scripts/release-record.mjs';
const REV = 'a'.repeat(40), TREE = 'b'.repeat(40), TOOL = 'c'.repeat(40);
const origins = ['https://room.example', 'https://entry.example/room'];
const AT = '2026-10-29T01:00:00.000Z', DONE = '2026-10-29T01:01:00.000Z';
function receipt() {
  const checks = origins.flatMap(door => [
    ...['/api/version', '/api/version/worker'].map(path => ({ name: `version ${door}${path}`, pass: true, status: 200, got: REV })),
    { name: `health ${door}/api/health`, pass: true, status: 200, body: 'ok' },
    { name: `ready ${door}/api/ready`, pass: true, status: 200, body: 'ready', do: { status: 'ok' }, emailVerification: 'enforced', emailVerificationScope: 'durable-object' },
    ...['/terms', '/privacy', '/'].map(path => ({ name: `page ${door}${path}`, pass: true, status: 200 })),
    { name: `agent-card ${door}/.well-known/agent-card.json`, pass: true, fetches: 10, attempts: 10, converged: true, failureCount: 0, failures: [] }
  ]);
  const doors = origins.flatMap(origin => [false, true].map(worker => ({ origin, checkedAt: AT, httpStatus: 200,
    value: { status: 'ok', sourceRevision: REV, ...(worker ? { servedBy: 'worker' } : {}) } })));
  return { schemaVersion: 1, mode: 'verify-only', expectedRevision: REV, state: 'verified', stable: true, origins, startedAt: AT, completedAt: DONE,
    sourceBefore: { revision: REV, tree: TREE, clean: true }, sourceAfter: { revision: REV, tree: TREE, clean: true },
    toolingBefore: { revision: TOOL, tree: TOOL, clean: true }, toolingAfter: { revision: TOOL, tree: TOOL, clean: true },
    before: doors, after: structuredClone(doors),
    strict: { exitCode: 0, report: { ok: true, sha: REV, origin: origins[0], entry: origins[1], checks } },
    live: { exitCode: 0, report: { ok: true, origin: origins[0], liveRevision: REV, findings: [{ code: 'deploy_pending', severity: 'warn', detail: 'PRIVATE DETAIL' }] } } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-record-')); t.after(() => rm(root, { recursive: true, force: true }));
  const args = { repository: 'Uuriko/project-room', revision: REV, tree: TREE, evidenceRoot: root, attempts: [] };
  const save = async (name, r) => {
    const directory = join(root, name); await mkdir(directory, { recursive: true });
    for (const [file, value] of [['receipt.json', r], ['strict-smoke.json', r.strict], ['live-smoke.json', r.live]]) {
      if (value !== undefined) await writeFile(join(directory, file), JSON.stringify(value));
    }
    return `${name}/receipt.json`;
  };
  return { root, args, save };
}

test('mixed revisions, source trees and missing/corrupt files are refused', async t => {
  const f = await fixture(t), r = receipt(); r.expectedRevision = TOOL;
  const path = await f.save('one', r);
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: [path] }), /mixed_target_revision/);
  r.expectedRevision = REV; r.sourceBefore.tree = TOOL; await f.save('one', r);
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: [path] }), /mixed_target_source/);
  r.sourceBefore.tree = TREE; await f.save('one', r);
  await writeFile(join(f.root, 'one/live-smoke.json'), '{');
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: [path] }), /invalid_evidence_json/);
  await rm(join(f.root, 'one/live-smoke.json'));
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: [path] }), /ENOENT/);
});

test('fabricated verified flags do not override failed smoke, missing door, or invalid card facts', async t => {
  const f = await fixture(t);
  for (const [name, alter] of [
    ['failed', r => { r.strict.exitCode = 1; r.strict.report.ok = false; r.strict.report.checks[0].pass = false; }],
    ['door', r => { r.after[0].httpStatus = 503; }],
    ['card', r => { r.strict.report.checks.at(-1).attempts = 1; }],
    ['unknown', r => { r.after.pop(); }]
  ]) {
    const r = receipt(); alter(r); const path = await f.save(name, r);
    const record = await composeReleaseRecord({ ...f.args, attempts: [path] });
    assert.equal(record.attempts[0].result, 'failed'); assert.equal(record.attempts[0].claimedStateConsistent, false);
    assert.equal(record.observations.publication.state, 'unknown');
  }
});

test('changed sidecars and original failure digest tampering are refused', async t => {
  const f = await fixture(t), r = receipt(), path = await f.save('one', r);
  await writeFile(join(f.root, 'one/strict-smoke.json'), JSON.stringify({ exitCode: 0, report: {} }));
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: [path] }), /sidecar_receipt_mismatch/);
  const failed = structuredClone(r.strict.report); failed.ok = false; failed.checks[0].pass = false;
  const bytes = JSON.stringify(failed); r.originalFailure = { file: 'original-failure.json', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) };
  await f.save('one', r); await writeFile(join(f.root, 'one/original-failure.json'), bytes);
  const record = await composeReleaseRecord({ ...f.args, attempts: [path] });
  assert.equal(record.attempts[0].originalFailure.result, 'failed');
  await writeFile(join(f.root, 'one/original-failure.json'), bytes + ' ');
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: [path] }), /original_failure_digest_mismatch/);
});

test('failed-success-failed history and identity/order are deterministic without claiming current health', async t => {
  const f = await fixture(t); const paths = [];
  for (let index = 0; index < 3; index++) {
    const r = receipt(); r.completedAt = `2026-10-29T01:0${index + 1}:00.000Z`;
    if (index !== 1) { r.state = 'failed'; r.strict.exitCode = 1; r.strict.report.ok = false; r.strict.report.checks[0].pass = false; }
    paths.push(await f.save(`attempt-${index}`, r));
  }
  const a = await composeReleaseRecord({ ...f.args, attempts: paths }), b = await composeReleaseRecord({ ...f.args, attempts: [...paths].reverse() });
  assert.deepEqual(a, b); assert.deepEqual(a.attempts.map(row => row.result), ['failed', 'verified-observation', 'failed']);
  assert.equal(a.observations.verification.latestResult, 'failed'); assert.equal(a.observations.verification.currentHealth, 'unknown');
  for (const kind of ['merge', 'deployment', 'publication']) assert.equal(a.observations[kind].state, 'unknown');
  assert.equal(JSON.stringify(a).includes('PRIVATE DETAIL'), false);
  assert.equal(JSON.stringify(a).includes(f.root), false);
});

test('explicit evidence root and bounded file reader prevent unrelated-file ingestion', async t => {
  const f = await fixture(t); const external = await mkdtemp(join(tmpdir(), 'record-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'private.json'), '{}'); await symlink(join(external, 'private.json'), join(f.root, 'escape.json'));
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: ['escape.json'] }), /evidence_outside_root/);
  await writeFile(join(f.root, 'huge.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(composeReleaseRecord({ ...f.args, attempts: ['huge.json'] }), /evidence_too_large/);
});

test('real read-only CLI emits portable record and concise summary without mutating evidence', async t => {
  const f = await fixture(t), path = await f.save('one', receipt());
  const before = await readFile(join(f.root, path));
  const cli = fileURLToPath(new URL('../scripts/release-record.mjs', import.meta.url));
  const args = [cli, '--repo', f.args.repository, '--revision', REV, '--tree', TREE, '--evidence-root', f.root, '--attempt', path];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stderr, /current health, merge, deployment and publication unknown/);
  assert.equal(JSON.parse(run.stdout).attempts[0].result, 'verified-observation');
  assert.deepEqual(await readFile(join(f.root, path)), before);
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /No network or mutation APIs/);
});
