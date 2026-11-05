import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { HEALTH_PROBE_TIMEOUT_MS } from './health-probe.mjs';
const origin = 'https://room.example.test';
async function setup(t, binding = true) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./backup-health.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'BackupHealthProbe', useSQLite: true } }, kvNamespaces: binding ? ['ROOM_BACKUPS_KV'] : [], bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: '0' } });
  t.after(() => mf.dispose());
  return (path, method = 'GET') => mf.dispatchFetch(origin + path, { method, headers: { 'CF-Connecting-IP': '203.0.113.1' } });
}
test('actual DO failed backup retries at slowcron boundary and successful daily backup does not repeat', async t => {
  const call = await setup(t);
  const first = await (await call('/test/run')).json(); assert.equal(first.manifests, 0);
  assert.equal(first.health.jobs.find(row => row.name === 'room-backup').lastErrorCode, 'backup_part_write_failed');
  assert.equal(first.health.jobs.find(row => row.name === 'room-backup').lastErrorComponent, 'part_write');
  const immediate = await (await call('/test/run')).json(); assert.equal(immediate.puts, first.puts);
  await call('/test/age');
  const retry = await (await call('/test/run')).json(); assert.equal(retry.manifests, 1);
  assert.equal(retry.health.jobs.find(row => row.name === 'room-backup').consecutiveFailures, 0);
  const success = await (await call('/test/run')).json(); assert.equal(success.puts, retry.puts);
});
test('actual Worker health distinguishes live process from failed stale and timed-out jobs, including HEAD', async t => {
  const call = await setup(t);
  for (const mode of ['normal', 'failing', 'stale', 'error', 'timeout']) {
    await call('/test/mode?mode=' + mode);
    const started = Date.now(), response = await call('/api/health');
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.liveness, 'ok');
    assert.equal(body.status, mode === 'normal' ? 'ok' : 'degraded');
    assert.equal(body.jobs.status, mode === 'normal' ? 'ok' : mode);
    if (mode === 'timeout') assert.ok(Date.now() - started < HEALTH_PROBE_TIMEOUT_MS + 400, 'bounded response before delayed DO result');
    const head = await call('/api/health', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
});
test('actual Worker missing required backup binding reports degraded while remaining live', async t => {
  const call = await setup(t, false); await call('/test/mode?mode=normal');
  const response = await call('/api/health'), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.status, 'degraded'); assert.equal(body.liveness, 'ok'); assert.equal(body.jobs.status, 'failing');
});
