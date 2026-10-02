import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthProbe, healthLivenessResponse, healthProbeResponse } from './health-probe.mjs';

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
  const onSnapshot = snapshot => healthProbeResponse(snapshot, healthRequest());
  const onUnready = readiness => healthLivenessResponse(healthRequest(), { mode: 'cloudflare-staging', readiness });
  const [first, second] = await Promise.all([
    probe({ start, timeoutMs: 50, onSnapshot, onUnready, waitUntil }),
    probe({ start, timeoutMs: 50, onSnapshot, onUnready, waitUntil })
  ]);
  assert.equal(starts, 1);
  assert.ok(keptAlive >= 1);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.deepEqual(firstBody, secondBody);
  assert.deepEqual(secondBody.durableObject, { ready: false, status: 'timeout' });
});

test('a ready probe reports durable-object readiness and passes a denial through', async () => {
  const probe = createHealthProbe();
  const ready = await probe({
    timeoutMs: 200,
    start: async () => new Response(JSON.stringify({ status: 'ok', mode: 'cloudflare-staging' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Server-Timing': 'app;dur=3', 'Content-Length': '40' }
    }),
    onSnapshot: snapshot => healthProbeResponse(snapshot, healthRequest()),
    onUnready: () => { throw new Error('a fast probe must not time out'); }
  });
  const body = await ready.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.mode, 'cloudflare-staging');
  assert.deepEqual(body.durableObject, { ready: true, status: 200 });
  assert.match(ready.headers.get('server-timing'), /app;dur=3/);
  assert.equal(ready.headers.get('content-length'), null);

  const denied = await probe({
    timeoutMs: 200,
    start: async () => new Response('no', { status: 403, headers: { 'Content-Type': 'text/plain' } }),
    onSnapshot: snapshot => healthProbeResponse(snapshot, healthRequest()),
    onUnready: () => { throw new Error('a denial is a finished probe'); }
  });
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), 'no');
});

test('a probe that throws reports error readiness', async () => {
  const probe = createHealthProbe();
  const response = await probe({
    timeoutMs: 200,
    start: async () => { throw new Error('constructor failed'); },
    onSnapshot: () => { throw new Error('no snapshot'); },
    onUnready: readiness => healthLivenessResponse(healthRequest(), { mode: 'cloudflare-staging', readiness })
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).durableObject, { ready: false, status: 'error' });
});

test('HEAD liveness has an empty body', async () => {
  const response = healthLivenessResponse(healthRequest('HEAD'), { mode: 'cloudflare-staging', readiness: 'timeout' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});
