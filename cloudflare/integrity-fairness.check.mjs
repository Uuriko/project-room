import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual integrity phase yield admits a queued RPC before the next verifier', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./integrity-fairness.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'IntegrityFairnessProbe', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
  try {
    const response = await mf.dispatchFetch('https://room.example.test/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), ['incremental', 'queued-read', 'deferred']);
  } finally { await mf.dispose(); }
});
