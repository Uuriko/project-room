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
  assert.equal(secondBody.status, 'degraded');
  assert.deepEqual(secondBody.durableObject, { ready: false, status: 'timeout' });
  assert.deepEqual(secondBody.do, { status: 'timeout', timeoutMs: 1000 });
});

test('concurrent probes share storage but shape separate GET/HEAD responses and do not cache completion', async () => {
  const probe = createHealthProbe(); let starts = 0, complete;
  const start = () => { starts++; return new Promise(resolve => { complete = resolve; }); };
  const options = method => ({ start, timeoutMs: 200,
    onSnapshot: (snapshot, timing) => readyProbeResponse(snapshot, healthRequest(method), { mode: method, elapsedMs: timing.elapsedMs }),
    onUnready: () => { throw new Error('unexpected timeout'); } });
  const get = probe(options('GET')), head = probe(options('HEAD'));
  complete(Response.json({ emailVerification: 'enforced' }));
  const [getResponse, headResponse] = await Promise.all([get, head]);
  assert.equal(starts, 1);
  const body = await getResponse.json();
  assert.equal(body.mode, 'GET'); assert.equal(body.emailVerification, 'enforced');
  assert.equal(headResponse.status, 200); assert.equal(await headResponse.text(), '');
  const fresh = probe(options('GET'));
  assert.equal(starts, 2, 'completed snapshots are not cached');
  complete(Response.json({ emailVerification: 'relaxed-no-mailer' }));
  assert.equal((await (await fresh).json()).emailVerification, 'relaxed-no-mailer');
});

test('a shorter joiner deadline does not cancel or duplicate its leader', async () => {
  const probe = createHealthProbe(); let complete, starts = 0, keptAlive = 0;
  const start = () => { starts++; return new Promise(resolve => { complete = resolve; }); };
  const options = { start, waitUntil: promise => { keptAlive++; promise.catch(() => {}); },
    onSnapshot: () => 'ready', onUnready: reason => reason };
  const leader = probe({ ...options, timeoutMs: 500 });
  assert.equal(await probe({ ...options, timeoutMs: 10 }), 'timeout');
  assert.equal(starts, 1); assert.equal(keptAlive, 1);
  complete(Response.json({ status: 'ok' }));
  assert.equal(await leader, 'ready');
});

test('a timed-out leader can still supply an active joiner within its own deadline', async () => {
  const probe = createHealthProbe(); let complete, starts = 0;
  const options = { start: () => { starts++; return new Promise(resolve => { complete = resolve; }); },
    waitUntil: promise => promise.catch(() => {}), onSnapshot: () => 'ready', onUnready: reason => reason };
  const leader = probe({ ...options, timeoutMs: 10 });
  const joiner = probe({ ...options, timeoutMs: 500 });
  assert.equal(await leader, 'timeout');
  complete(Response.json({}));
  assert.equal(await joiner, 'ready');
  assert.equal(starts, 1);
});

test('shared failures reach every caller and a later request retries freshly', async () => {
  const probe = createHealthProbe(); let reject, starts = 0;
  const options = { timeoutMs: 200, start: () => { starts++; return new Promise((_, fail) => { reject = fail; }); },
    onSnapshot: () => 'ready', onUnready: reason => reason };
  const leader = probe(options), joiner = probe(options);
  reject(new Error('RPC failed'));
  assert.deepEqual(await Promise.all([leader, joiner]), ['error', 'error']);
  assert.equal(starts, 1);
  assert.equal(await probe({ ...options, start: async () => { starts++; return Response.json({}); } }), 'ready');
  assert.equal(starts, 2);
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

test('HEAD liveness has an empty body', async () => {
  const response = healthLivenessResponse(healthRequest('HEAD'), { mode: 'cloudflare-staging', readiness: 'timeout' });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
});
