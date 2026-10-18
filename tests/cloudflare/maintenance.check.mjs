import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('real Workers pause rejects traffic before binding, bootstrap or unavailable storage', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./maintenance.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'], bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: '1' } });
  try {
    for (const [path, method] of [['/', 'GET'], ['/api/session', 'POST'], ['/api/rooms/commons/commands?ROOM_MAINTENANCE=0', 'POST'], ['/direct', 'GET']]) {
      const response = await mf.dispatchFetch(origin + path, { method });
      assert.equal(response.status, 503, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(response.headers.get('set-cookie'), null); assert.match(await response.text(), /temporarily paused/);
    }
    assert.equal((await mf.dispatchFetch('https://wrong.example.test/')).status, 403);
    assert.deepEqual(await (await mf.dispatchFetch(origin + '/configuration-checks')).json(), { invalidConfigurationRejected: true, normalStartupOpensStorage: true });
  } finally { await mf.dispose(); }
});
