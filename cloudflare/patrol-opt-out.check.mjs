import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual ProjectRoom scheduler and direct patrol RPC honor opt-out without touching patrol state', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./patrol-opt-out.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'PatrolOptOutProbe', useSQLite: true } }, bindings: { ROOM_ORIGIN: 'https://room.example.test', ROOM_PATROL_ENABLED: '0' } });
  try {
    const response = await mf.dispatchFetch('https://room.example.test/');assert.equal(response.status, 200);
    const r = await response.json();
    assert.deepEqual(r.selected, []);assert.equal(r.alarm, null);assert.equal(r.scans, 0);
    assert.equal(r.health.status, 'disabled');assert.match(r.health.reason, /ROOM_PATROL_ENABLED=0/);
    assert.deepEqual(r.rpc, { skipped: 1, disabled: 1 });assert.ok(!r.cron.ran.includes('patrol'));
    assert.deepEqual(r.before, r.after);assert.notDeepEqual(r.manual, r.before);
    console.log(JSON.stringify({ scans: r.scans, status: r.health.status, schedulerRan: r.cron.ran, preserved: true, manualRecheck: true }));
  } finally { await mf.dispose(); }
});
