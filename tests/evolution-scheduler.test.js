import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openEvolution, digest } from '../client/evolution/store.mjs';
import { installPackage, activate } from '../client/evolution/registry.mjs';
import { configure, submit, getJob } from '../client/evolution/executor.mjs';
import { watchLocalCapabilities, executionMetrics } from '../client/evolution/scheduler.mjs';
import { command } from '../scripts/room-evolution.mjs';
const memory = 64 * 1024 ** 2;
const source = `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const input=JSON.parse(readFileSync(process.env.ROOM_TASK_INPUT));
writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'started'),'yes');
while(!existsSync(input.release)) await new Promise(r=>setTimeout(r,20));
writeFileSync(join(process.env.ROOM_TASK_OUTPUT,'result'),'done');`;
async function until(check) {
  const deadline = Date.now() + 8000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition did not become true'); await delay(20); }
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'evolution-scheduler-')), store = openEvolution(join(directory, 'state'));
  const p = { rooms: ['one'], capabilities: ['verify'], maxJobs: 2, cpuSlots: 2, memoryBytes: memory * 2, reserveMemoryBytes: 0, paused: false };
  configure(store, p);
  writeFileSync(join(directory, 'worker.mjs'), source);
  const pack = installPackage(store, directory, { schema: 1, capability: 'verify', version: 'v1', runtime: process.version,
    resources: { cpu: 1, memoryBytes: memory }, files: [{ path: 'worker.mjs', sha256: digest(source) }],
    steps: [{ id: 'verify', module: 'worker.mjs', args: [], timeoutMs: 10000 }] });
  activate(store, { capability: 'verify', hash: pack.hash, expectedRevision: 0, bootstrap: true, reason: 'fixture' });
  const controller = new AbortController(), runs = [];
  t.after(async () => { controller.abort(); await Promise.allSettled(runs); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const start = (options = {}) => { const run = watchLocalCapabilities(store, { signal: controller.signal, intervalMs: 200,
    observeResources: () => ({ at: Date.now(), cpuSlots: 8, memoryBytes: memory * 20 }), ...options }); runs.push(run); return run; };
  const job = name => submit(store, { room: 'one', operation: name, capability: 'verify', input: { release: join(directory, 'release') } });
  const started = j => existsSync(join(store.directory, 'runs', j.id, '1', 'artifacts', 'started'));
  return { store, p, directory, controller, start, job, started, release: () => writeFileSync(join(directory, 'release'), '') };
}
test('two actual children run concurrently, capacity stays bounded, completion refills and replay stays single-attempt', async t => {
  const f = fixture(t), a = f.job('a'), b = f.job('b'), c = f.job('c'), emitted = [];
  const run = f.start({ emit: value => emitted.push(value) });
  await until(() => f.started(a) && f.started(b));
  assert.equal(getJob(f.store, c.id).state, 'queued');
  f.release();
  await until(() => emitted.length === 3);
  f.controller.abort(); await run;
  for (const job of [a, b, c]) { assert.equal(getJob(f.store, job.id).state, 'completed'); assert.equal(f.job(job.operation).attempt, 1); }
  const metrics = await command(f.store, 'metrics');
  assert.equal(metrics.states.completed, 3); assert.equal(metrics.recordedSteps, 3); assert.equal(metrics.artifactCount, 6);
  assert.ok(metrics.stepElapsedMs > 0); assert.equal(metrics.tokenSavings, 'not_measured');
  assert.equal(JSON.stringify(metrics).includes(f.directory), false);
});
test('independent watchers share database reservations and shutdown awaits every child receipt', async t => {
  const f = fixture(t), a = f.job('a'), b = f.job('b'), c = f.job('c');
  const second = openEvolution(f.store.directory); t.after(() => second.close());
  const one = f.start(), two = watchLocalCapabilities(second, { intervalMs: 200, signal: f.controller.signal,
    observeResources: () => ({ at: Date.now(), cpuSlots: 8, memoryBytes: memory * 20 }) });
  try {
    await until(() => f.started(a) && f.started(b));
    assert.equal(getJob(f.store, c.id).state, 'queued');
    f.controller.abort(); await Promise.all([one, two]);
    const metrics = executionMetrics(f.store);
    assert.equal(metrics.states.running ?? 0, 0); assert.equal(getJob(f.store, c.id).attempt, 0);
    assert.equal(getJob(f.store, a.id).attempt, 1); assert.equal(getJob(f.store, b.id).attempt, 1);
  } finally { f.controller.abort(); await Promise.allSettled([one, two]); }
});
test('paused and resource-starved queue resumes under fresh local policy without model calls', async t => {
  const f = fixture(t), a = f.job('a'); let slots = 0;
  configure(f.store, { ...f.p, paused: true });
  const run = f.start({ observeResources: () => ({ at: Date.now(), cpuSlots: slots, memoryBytes: memory * 20 }) });
  await delay(250); assert.equal(getJob(f.store, a.id).attempt, 0);
  configure(f.store, f.p); await delay(250); assert.equal(getJob(f.store, a.id).attempt, 0);
  slots = 2; await until(() => f.started(a));
  f.release(); await until(() => getJob(f.store, a.id).state === 'completed');
  f.controller.abort(); await run;
});
test('denied queue head does not starve later authorized work', async t => {
  const f = fixture(t);
  configure(f.store, { ...f.p, rooms: ['one', 'blocked'], maxJobs: 64 });
  for (let i = 0; i < 65; i++) submit(f.store, { room: 'blocked', operation: String(i), capability: 'verify', input: {} });
  const job = f.job('allowed'); configure(f.store, { ...f.p, maxJobs: 64 }); f.release();
  const run = f.start(); await until(() => getJob(f.store, job.id).state === 'completed');
  f.controller.abort(); await run;
  assert.equal(executionMetrics(f.store).states.queued, 65);
});
test('observer failure drains previously started jobs before rejecting', async t => {
  const f = fixture(t), a = f.job('a'); f.job('b'); let calls = 0;
  const run = f.start({ observeResources: () => {
    if (++calls === 2) throw Error('sensor unavailable');
    return { at: Date.now(), cpuSlots: 8, memoryBytes: memory * 20 };
  } });
  await assert.rejects(run, /sensor unavailable/);
  assert.notEqual(getJob(f.store, a.id).state, 'running');
  assert.equal(getJob(f.store, a.id).owner, null);
});
