import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('Workerd patrol activation stays healthy and inspects only the indexed oldest pending event', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./patrol-health.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'PatrolHealthProbe', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
  try {
    const results = [];
    for (const count of [1000, 10000]) {
      const response = await mf.dispatchFetch(`https://room.example.test/?n=${count}`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.idle, 'disabled');assert.equal(result.fresh, 'ok');assert.equal(result.pendingKnown, true);
      assert.ok(result.rowsRead < 1500, JSON.stringify(result));results.push(result.rowsRead);
    }
    assert.equal(results[1], results[0]);
    console.log('patrol pending health rows read', results);
  } finally { await mf.dispose(); }
});
