import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthProbe, healthCacheMs, HEALTH_CACHE_MAX_MS, jobHealthSnapshotStatus, workerLivenessResponse } from './health-probe.mjs';

const request = new Request('https://room.example.test/api/health');
// ~prod: server-timing total;dur=193 on /api/health, almost all of it the DO RPC.
const RPC_MS = 200;
const slowStart = counter => () => new Promise(resolve => { counter.n++; setTimeout(() => resolve(Response.json({ schema: 'room.job-health/1', status: 'ok' })), RPC_MS); });
const call = (probe, start, cacheMs) => probe({ start, timeoutMs: 2500, cacheMs,
  onSnapshot: snapshot => workerLivenessResponse(request, { mode: 't', jobsStatus: jobHealthSnapshotStatus(snapshot) }),
  onUnready: jobsStatus => workerLivenessResponse(request, { mode: 't', jobsStatus }) });
async function timed(fn) { const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, body: await r.json() }; }

test('env parsing: unset/invalid is 0 (off); clamped to the max', () => {
  assert.equal(healthCacheMs({}), 0);
  assert.equal(healthCacheMs({ ROOM_HEALTH_JOBS_CACHE_MS: 'x' }), 0);
  assert.equal(healthCacheMs({ ROOM_HEALTH_JOBS_CACHE_MS: '-5' }), 0);
  assert.equal(healthCacheMs({ ROOM_HEALTH_JOBS_CACHE_MS: '3000' }), 3000);
  assert.equal(healthCacheMs({ ROOM_HEALTH_JOBS_CACHE_MS: '999999' }), HEALTH_CACHE_MAX_MS);
});

test('before/after: off pays the RPC every call; on reuses the last good snapshot', async () => {
  const off = { n: 0 }, probeOff = createHealthProbe();
  const before = [];
  for (let i = 0; i < 5; i++) before.push(await timed(() => call(probeOff, slowStart(off), 0)));
  assert.equal(off.n, 5);
  const on = { n: 0 }, probeOn = createHealthProbe();
  const after = [];
  for (let i = 0; i < 5; i++) after.push(await timed(() => call(probeOn, slowStart(on), 5000)));
  assert.equal(on.n, 1);
  for (const r of [...before, ...after]) assert.equal(r.body.jobs.status, 'ok');
  const median = xs => xs.map(x => x.ms).sort((a, b) => a - b)[2];
  console.log(`health probe median ms: off=${median(before).toFixed(1)} on=${median(after).toFixed(1)} (simulated ${RPC_MS}ms RPC)`);
  assert.ok(median(before) >= RPC_MS - 5);
  assert.ok(median(after) < 20);
});

test('cache expires, and timeouts/errors are never cached', async () => {
  let clock = 0; const probe = createHealthProbe({ now: () => clock });
  const c = { n: 0 };
  await call(probe, slowStart(c), 1000);
  clock = 999; await call(probe, slowStart(c), 1000);
  assert.equal(c.n, 1);
  clock = 1000; await call(probe, slowStart(c), 1000);
  assert.equal(c.n, 2);

  const p2 = createHealthProbe(); let fails = 0;
  const failing = () => { fails++; return Promise.reject(new Error('rpc down')); };
  assert.equal((await (await call(p2, failing, 5000)).json()).jobs.status, 'error');
  assert.equal((await (await call(p2, failing, 5000)).json()).jobs.status, 'error');
  assert.equal(fails, 2);
});
