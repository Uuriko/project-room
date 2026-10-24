import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEvolution } from '../client/evolution/store.mjs';
import { configure, runJob, getJob } from '../client/evolution/executor.mjs';
import { command } from '../scripts/room-evolution.mjs';
const memory = 64 * 1024 ** 2;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'room-onboarding-'))), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const store = openEvolution(join(root, 'state'));
  const policy = { rooms: ['room'], capabilities: ['workspace-inventory'], workspaces: [workspace], maxJobs: 1, cpuSlots: 1,
    memoryBytes: memory, reserveMemoryBytes: 0, paused: false };
  configure(store, policy);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const args = { workspace, room: 'room', operation: 'first-job' };
  const prepare = (overrides = {}) => command(store, 'first-job-prepare', { ...args, ...overrides });
  const run = job => runJob(store, job.jobId, { observation: { at: Date.now(), cpuSlots: 4, memoryBytes: memory * 8 } });
  const verify = (job, target = store) => command(target, 'first-job-verify', { jobId: job.jobId, expectedAttempt: job.expectedAttempt, expectedPin: job.pin });
  return { root, workspace, store, policy, prepare, run, verify };
}
test('real first job needs no Git/provider, produces bounded summary and verifies after state reopen without replay', async t => {
  const f = fixture(t); writeFileSync(join(f.workspace, 'one.txt'), 'private content'); mkdirSync(join(f.workspace, 'folder'));
  writeFileSync(join(f.workspace, '.secret'), 'private secret'); symlinkSync('/etc', join(f.workspace, 'outside'));
  const job = await f.prepare(); await assert.rejects(f.verify(job), /binding_changed|not_completed/);
  assert.equal((await f.run(job)).job.state, 'completed');
  const reopened = openEvolution(f.store.directory);
  try {
    const result = await f.verify(job, reopened);
    assert.deepEqual(result.summary, { schema: 1, kind: 'workspace-inventory', recursive: false, entries: 4, files: 1,
      directories: 1, symlinks: 1, other: 0, hiddenSkipped: 1, complete: true });
    assert.equal(result.qualified, true); assert.equal(result.twoDeviceQualified, false); assert.equal(result.roomArtifactQualified, false);
    assert.equal(JSON.stringify(result).includes(f.workspace), false); assert.equal(JSON.stringify(result).includes('private content'), false);
    assert.equal((await f.prepare()).jobId, job.jobId); assert.equal((await f.run(job)).claimed, false);
    assert.equal(getJob(reopened, job.jobId).attempt, 1);
  } finally { reopened.close(); }
});
test('explicit folder grant is required and revocation before run prevents execution', async t => {
  const f = fixture(t);
  configure(f.store, { ...f.policy, workspaces: [] }); await assert.rejects(f.prepare(), /workspace_grant_required/);
  configure(f.store, { ...f.policy, workspaces: f.workspace }); await assert.rejects(f.prepare(), /workspace_grant_required/);
  configure(f.store, f.policy); const job = await f.prepare();
  configure(f.store, { ...f.policy, workspaces: [] });
  assert.equal((await f.run(job)).reason, 'workspace_grant_required'); assert.equal(getJob(f.store, job.jobId).attempt, 0);
});
test('replacing the selected directory does not inherit its grant', async t => {
  const f = fixture(t), job = await f.prepare();
  renameSync(f.workspace, f.workspace + '-old'); mkdirSync(f.workspace);
  assert.equal((await f.run(job)).reason, 'workspace_changed');
  rmSync(f.workspace, { recursive: true }); symlinkSync(f.workspace + '-old', f.workspace);
  assert.equal((await f.run(job)).reason, 'workspace_changed');
});
test('qualification binds exact attempt and package and detects modified or redirected artifacts', async t => {
  const f = fixture(t), job = await f.prepare(); await f.run(job);
  await assert.rejects(f.verify({ ...job, expectedAttempt: 2 }), /binding_changed/);
  await assert.rejects(f.verify({ ...job, pin: '0'.repeat(64) }), /binding_changed/);
  const path = join(f.store.directory, 'runs', job.jobId, '1', 'artifacts', 'workspace-summary.json');
  writeFileSync(path, '{}'); await assert.rejects(f.verify(job), /artifact_changed/);
  rmSync(path); symlinkSync('/etc/hosts', path); await assert.rejects(f.verify(job), /artifact_invalid/);
});
test('large folders stop at a fixed entry budget and report partial coverage', async t => {
  const f = fixture(t); for (let i = 0; i < 520; i++) writeFileSync(join(f.workspace, 'f' + i), '');
  const job = await f.prepare(); await f.run(job); const result = await f.verify(job);
  assert.equal(result.summary.entries, 512); assert.equal(result.summary.files, 512); assert.equal(result.summary.complete, false);
});
