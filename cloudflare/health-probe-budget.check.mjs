import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { HEALTH_PROBE_TIMEOUT_MS } from './health-probe.mjs';
const origin = 'https://room.example.test';
async function fixture(t, config) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./health-probe-budget.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], bindings: { ROOM_ORIGIN: origin }, durableObjects: { ROOM: { className: 'BudgetProbe', useSQLite: true } } });
  t.after(() => mf.dispose());
  const fetch = (path, options) => mf.dispatchFetch(origin + path, options);
  await fetch('/configure', { method: 'POST', body: JSON.stringify(config) });
  return { fetch, count: async () => (await (await fetch('/count')).json()).count };
}
for (const delay of [1200, 1800]) test(`actual Worker accepts a successful ${delay}ms readiness RPC once, without caching`, async t => {
  const f = await fixture(t, { delay });
  const [get, head] = await Promise.all([f.fetch('/api/ready'), f.fetch('/api/ready', { method: 'HEAD' })]);
  assert.equal(get.status, 200); assert.equal((await get.json()).status, 'ready');
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(await f.count(), 1);
  assert.equal((await f.fetch('/api/ready')).status, 200); assert.equal(await f.count(), 2);
});
test('actual Worker stalled RPC remains bounded and shared; static Worker version does not probe', async t => {
  const f = await fixture(t, { stalled: true });
  assert.equal((await f.fetch('/api/version/worker')).status, 200);
  assert.equal(await f.count(), 0);
  const [a, b] = await Promise.all([f.fetch('/api/ready'), f.fetch('/api/ready')]);
  for (const response of [a, b]) {
    assert.equal(response.status, 503); const body = await response.json();
    assert.equal(body.durableObject.ready, false); assert.equal(body.do.status, 'timeout');
    assert.equal(body.do.timeoutMs, 2500); assert.ok(body.do.ms >= 2400 && body.do.ms < 4000);
  }
  assert.equal(await f.count(), 1); await f.fetch('/unblock');
});
for (const config of [{ error: true }, { ok: false }]) test(`actual Worker still refuses ${JSON.stringify(config)} readiness`, async t => {
  const f = await fixture(t, config); const response = await f.fetch('/api/ready');
  assert.equal(response.status, 503); assert.equal((await response.json()).do.status, 'error');
  assert.equal(await f.count(), 1);
});
test('actual Worker joining caller gets its own deadline after leader timeout', async t => {
  assert.equal(HEALTH_PROBE_TIMEOUT_MS, 2500);
  const f = await fixture(t, { delay: 3200 });
  const leader = f.fetch('/api/ready');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const joiner = f.fetch('/api/ready');
  assert.equal((await leader).status, 503);
  assert.equal((await joiner).status, 200); assert.equal(await f.count(), 1);
});
test('actual Worker health summary accepts slow successful job RPC without changing liveness semantics', async t => {
  const f = await fixture(t, { delay: 1200 }); const response = await f.fetch('/api/health');
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.liveness, 'ok'); assert.equal(body.jobs.status, 'ok'); assert.equal(await f.count(), 1);
});
