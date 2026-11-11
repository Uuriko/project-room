import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual Workerd idle inbox avoids whole-room hydration on a cold projection cache', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./idle-inbox-hydration.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'IdleInboxProbe', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
  try {
    const response = await mf.dispatchFetch('https://room.example.test/');assert.equal(response.status, 200);
    const result = await response.json();console.log('idle-inbox profile', result);
    assert.equal(result.same, true);assert.ok(result.projectionBytes > 400000);assert.ok(result.retainedMessages >= 30);
    assert.equal(result.hydrations, 0);
  } finally { await mf.dispose(); }
});
