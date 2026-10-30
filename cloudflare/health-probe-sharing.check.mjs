import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual Worker coalesces GET/HEAD readiness RPCs without sharing origin authorization or caching results', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./health-probe-sharing.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], bindings: { ROOM_ORIGIN: origin }, durableObjects: { ROOM: { className: 'ReadinessCounter', useSQLite: true } } });
  try {
    // Warm the isolate only; this does not call probeStorage.
    assert.equal((await (await mf.dispatchFetch(origin + '/count')).json()).count, 0);
    const [get, head, denied] = await Promise.all([
      mf.dispatchFetch(origin + '/api/ready'),
      mf.dispatchFetch(origin + '/api/ready', { method: 'HEAD' }),
      mf.dispatchFetch(origin + '/api/ready', { headers: { Origin: 'https://untrusted.invalid' } })
    ]);
    assert.equal(get.status, 200); assert.equal((await get.json()).emailVerification, 'enforced');
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(denied.status, 403);
    assert.equal((await (await mf.dispatchFetch(origin + '/count')).json()).count, 1);
    assert.equal((await mf.dispatchFetch(origin + '/api/ready')).status, 200);
    assert.equal((await (await mf.dispatchFetch(origin + '/count')).json()).count, 2);
  } finally { await mf.dispose(); }
});
