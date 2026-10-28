import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthProbe, healthLivenessResponse, readyProbeResponse } from './health-probe.mjs';

const healthRequest = (method = 'GET') => new Request('https://room.example.test/api/health', { method });

test('a slow Durable Object probe answers liveness from one shared fetch', async () => {
  const probe = createHealthProbe();
  let starts = 0;
  let keptAlive = 0;
  const start = () => new Promise(resolve => {
    starts += 1;
    setTimeout(() => resolve(Response.json({ status: 'ok', mode: 'cloudflare-staging' })), 1000);
  });
  const waitUntil = promise => { keptAlive += 1; promise.then(() => {}, () => {}); };
  const onSnapshot = snapshot => readyProbeResponse(snapshot, healthRequest(), { mode: 'cloudflare-staging' });
  const onUnready = readiness => healthLivenessResponse(healthRequest(), { mode: 'cloudflare-staging', readiness });
  const [first, second] = await Promise.all([
    probe({ start, timeoutMs: 50, onSnapshot, onUnready, waitUntil }),
    probe({ start, timeoutMs: 50, onSnapshot, onUnready, waitUntil })
  ]);
  assert.equal(starts, 1);
  assert.ok(keptAlive >= 1);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(first.status, 503);
  assert.equal(second.status, 503);
  assert.deepEqual(firstBody, secondBody);
  // No verdict has ever settled and the start is still pending: this is a
  // cold start, reported as "starting", not as degraded/timeout.
  assert.equal(secondBody.status, 'starting');
  assert.deepEqual(secondBody.durableObject, { ready: false, status: 'starting' });
  assert.deepEqual(secondBody.do, { status: 'starting', timeoutMs: 1000 });
});

test('a joined probe is served from the shared start, never its own start()', async () => {
  const probe = createHealthProbe();
  let keptAlive = 0;
  const waitUntil = promise => { keptAlive += 1; promise.then(() => {}, () => {}); };
  const onSnapshot = (snapshot, timing) => readyProbeResponse(snapshot, healthRequest(), { mode: 'cloudflare-staging', elapsedMs: timing.elapsedMs });
  const onUnready = (readiness, timing) => healthLivenessResponse(healthRequest(), { mode: 'cloudflare-staging', readiness, ...timing });
  // The shared start is the single store call: a joiner arriving while it is
  // in flight is answered from its snapshot within its own budget. It never
  // launches a second store call of its own (the pre-cache design ran the
  // joiner's own start() after the gate settled, queueing a second call on
  // the contended object per concurrent probe).
  let leaderStarts = 0;
  let joinerStarts = 0;
  const leaderStart = () => new Promise(resolve => {
    leaderStarts += 1;
    setTimeout(() => resolve(Response.json({ status: 'ok' })), 10);
  });
  const joinerStart = () => new Promise(resolve => {
    joinerStarts += 1;
    setTimeout(() => resolve(Response.json({ status: 'ok' })), 1000);
  });
  const startedAt = performance.now();
  const [leader, joiner] = await Promise.all([
    probe({ start: leaderStart, timeoutMs: 50, onSnapshot, onUnready, waitUntil }),
    probe({ start: joinerStart, timeoutMs: 50, onSnapshot, onUnready, waitUntil })
  ]);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(leader.status, 200);
  assert.equal(joiner.status, 200);
  assert.equal((await joiner.json()).status, 'ready');
  assert.equal(leaderStarts, 1);
  assert.equal(joinerStarts, 0, 'a joiner must not queue its own store call');
  assert.ok(elapsedMs < 400, `joined probe took ${Math.round(elapsedMs)}ms, expected the shared answer near 10ms`);
});

test('a ready probe reports storage readiness', async () => {
  const probe = createHealthProbe();
  const ready = await probe({
    timeoutMs: 200,
    start: async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }),
    onSnapshot: (snapshot, timing) => readyProbeResponse(snapshot, healthRequest(), { mode: 'cloudflare-staging', elapsedMs: timing.elapsedMs }),
    onUnready: () => { throw new Error('a fast probe must not time out'); }
  });
  const body = await ready.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.mode, 'cloudflare-staging');
  assert.equal(body.do.status, 'ok');
  assert.equal(body.do.statusCode, 200);
  assert.equal(typeof body.do.ms, 'number');

  const head = readyProbeResponse({ status: 200 }, healthRequest('HEAD'), { mode: 'cloudflare-staging', elapsedMs: 4 });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('a probe that throws reports error readiness', async () => {
  const probe = createHealthProbe();
  const response = await probe({
    timeoutMs: 200,
    start: async () => { throw new Error('constructor failed'); },
    onSnapshot: () => { throw new Error('no snapshot'); },
    onUnready: (readiness, timing) => healthLivenessResponse(healthRequest(), { mode: 'cloudflare-staging', readiness, ...timing })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.durableObject, { ready: false, status: 'error' });
  assert.equal(body.do.status, 'error');
  assert.equal(typeof body.do.ms, 'number');
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const probeHandlers = () => ({
  onSnapshot: (snapshot, timing) => readyProbeResponse(snapshot, healthRequest(), { mode: 'cloudflare-staging', elapsedMs: timing.elapsedMs }),
  onUnready: (readiness, timing) => healthLivenessResponse(healthRequest(), { mode: 'cloudflare-staging', readiness, ...timing })
});

test('ready verdict is cached for the TTL: repeated probes do not re-enter the store', async () => {
  const probe = createHealthProbe({ cacheTtlMs: 120 });
  let starts = 0;
  const start = async () => { starts += 1; return Response.json({ status: 'ok', emailVerification: 'enforced' }); };
  for (let i = 0; i < 5; i += 1) {
    const response = await probe({ start, timeoutMs: 200, ...probeHandlers() });
    assert.equal(response.status, 200);
  }
  assert.equal(starts, 1, 'probes inside the TTL window must serve the cached verdict, not queue on the store');
  await sleep(160);
  const after = await probe({ start, timeoutMs: 200, ...probeHandlers() });
  assert.equal(after.status, 200);
  assert.equal(starts, 2, 'the first probe after the TTL must re-probe the store');
});

test('a genuinely failing store still surfaces as 503 once the cached verdict expires', async () => {
  const probe = createHealthProbe({ cacheTtlMs: 80 });
  let failing = false;
  let starts = 0;
  const start = async () => { starts += 1; if (failing) throw new Error('store down'); return Response.json({ status: 'ok' }); };
  assert.equal((await probe({ start, timeoutMs: 200, ...probeHandlers() })).status, 200);
  failing = true;
  const masked = await probe({ start, timeoutMs: 200, ...probeHandlers() });
  assert.equal(masked.status, 200, 'inside the TTL the cached verdict is served (bounded masking window)');
  assert.equal(starts, 1);
  await sleep(120);
  const surfaced = await probe({ start, timeoutMs: 200, ...probeHandlers() });
  assert.equal(surfaced.status, 503, 'after the TTL a real failure must surface');
  const body = await surfaced.json();
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.durableObject, { ready: false, status: 'error' });
});

test('cold start: a first probe that times out reports starting, then ready once the store answers at all', async () => {
  const probe = createHealthProbe({ cacheTtlMs: 1000 });
  let starts = 0;
  let keptAlive = 0;
  const waitUntil = promise => { keptAlive += 1; promise.then(() => {}, () => {}); };
  const start = () => new Promise(resolve => { starts += 1; setTimeout(() => resolve(Response.json({ status: 'ok' })), 250); });
  const first = await probe({ start, timeoutMs: 40, waitUntil, ...probeHandlers() });
  assert.equal(first.status, 503);
  const firstBody = await first.json();
  assert.equal(firstBody.status, 'starting', 'a constructor in progress is starting, not degraded/unready');
  assert.deepEqual(firstBody.durableObject, { ready: false, status: 'starting' });
  assert.equal(firstBody.do.status, 'starting');
  const second = await probe({ start, timeoutMs: 40, waitUntil, ...probeHandlers() });
  assert.equal(second.status, 503);
  assert.equal((await second.json()).status, 'starting');
  assert.equal(starts, 1, 'probes during a cold start join the pending start, they do not queue new store calls');
  await sleep(300);
  const third = await probe({ start, timeoutMs: 40, waitUntil, ...probeHandlers() });
  assert.equal(third.status, 200, 'once the cold store answers at all, readiness is ready from its answer');
  assert.equal((await third.json()).status, 'ready');
  assert.equal(starts, 1, 'the cold-start answer populates the cache; no fresh store call is needed');
  assert.ok(keptAlive >= 1);
});

test('a timeout after a settled verdict is busy contention (degraded/timeout), not starting', async () => {
  const probe = createHealthProbe({ cacheTtlMs: 60 });
  const fast = async () => Response.json({ status: 'ok' });
  assert.equal((await probe({ start: fast, timeoutMs: 200, ...probeHandlers() })).status, 200);
  await sleep(100);
  const slow = () => new Promise(resolve => setTimeout(() => resolve(Response.json({ status: 'ok' })), 250));
  const busy = await probe({ start: slow, timeoutMs: 40, waitUntil: p => p.then(() => {}, () => {}), ...probeHandlers() });
  assert.equal(busy.status, 503);
  const body = await busy.json();
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.durableObject, { ready: false, status: 'timeout' });
  assert.equal(body.do.status, 'timeout');
});

test('HEAD liveness has an empty body', async () => {
  const response = healthLivenessResponse(healthRequest('HEAD'), { mode: 'cloudflare-staging', readiness: 'timeout' });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
});
