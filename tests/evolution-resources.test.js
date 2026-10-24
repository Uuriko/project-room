import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeResources, resourceGate } from '../client/evolution/resources.mjs';
import { openEvolution } from '../client/evolution/store.mjs';
import { configure, runJob, getJob, readiness } from '../client/evolution/executor.mjs';
import { prepareFirstJob } from '../client/evolution/onboarding.mjs';
const GiB = 1024 ** 3;
const observation = () => ({ at: Date.now(), cpuSlots: 4, memoryBytes: GiB, diskAvailableBytes: 2 * GiB, memoryPressure: 'normal' });
test('required resource guards refuse unavailable, stale and pressured observations', () => {
  const policy = { reserveDiskBytes: GiB, requireNormalMemoryPressure: true };
  for (const [patch, reason] of [[{ diskAvailableBytes: null }, 'disk_observation_unavailable'],
    [{ diskAvailableBytes: GiB - 1 }, 'disk_headroom'], [{ memoryPressure: 'warning' }, 'memory_pressure'],
    [{ memoryPressure: 'critical' }, 'memory_pressure'], [{ memoryPressure: 'unsupported' }, 'memory_pressure_unavailable'],
    [{ at: Date.now() - 31000 }, 'stale_resources'], [{ cpuSlots: -1 }, 'stale_resources']]) {
    assert.deepEqual(resourceGate(policy, { ...observation(), ...patch }), { allowed: false, reason });
  }
  assert.equal(resourceGate(policy, { ...observation(), diskAvailableBytes: GiB }).allowed, true);
  assert.equal(resourceGate({}, { at: Date.now(), cpuSlots: 1, memoryBytes: GiB }).allowed, true);
});
test('disk telemetry describes requested state filesystem and fails closed on missing directory', () => {
  assert.ok(observeResources(tmpdir()).diskAvailableBytes > 0);
  assert.equal(observeResources(join(tmpdir(), 'missing-room-state-' + Date.now())).diskAvailableBytes, null);
});
test('blocked real job keeps attempt zero, recovers once, and readiness excludes workspace paths', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'room-resource-'))), workspace = join(root, 'workspace');
  mkdirSync(workspace); const store = openEvolution(join(root, 'state'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const policy = { rooms: ['r'], capabilities: ['workspace-inventory'], workspaces: [workspace], maxJobs: 1,
    cpuSlots: 1, memoryBytes: GiB, reserveMemoryBytes: 0, paused: false, reserveDiskBytes: GiB, requireNormalMemoryPressure: true };
  configure(store, policy);
  for (const patch of [{ reserveDiskBytes: -1 }, { reserveDiskBytes: 1.1 }, { requireNormalMemoryPressure: 'yes' }])
    assert.throws(() => configure(store, { ...policy, ...patch }), /invalid_policy/);
  const job = prepareFirstJob(store, { workspace, room: 'r', operation: 'guard-recovery' });
  for (const patch of [{ diskAvailableBytes: 0 }, { memoryPressure: 'warning' }]) {
    const sample = { ...observation(), ...patch };
    assert.equal(readiness(store, sample).ready, false);
    assert.equal((await runJob(store, job.jobId, { observation: sample })).claimed, false);
    assert.equal(getJob(store, job.jobId).attempt, 0);
  }
  assert.equal(readiness(store, observation()).ready, true);
  assert.equal(readiness(store, { ...observation(), cpuSlots: 0 }).reason, 'resources_unavailable');
  assert.equal(readiness(store, { ...observation(), memoryBytes: 0 }).reason, 'resources_unavailable');
  assert.equal(JSON.stringify(readiness(store, observation())).includes(workspace), false);
  assert.equal((await runJob(store, job.jobId, { observation: observation() })).job.state, 'completed');
  assert.equal((await runJob(store, job.jobId, { observation: observation() })).claimed, false);
  assert.equal(getJob(store, job.jobId).attempt, 1);
  configure(store, { ...policy, paused: true }); assert.equal(readiness(store, observation()).reason, 'paused');
});
