import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('full-schema writer fences use bounded metadata reads and retain reconciliation and permit protection', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./writer-fence-metadata.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'FenceMetadataRoom', useSQLite: true } } });
  try {
    for (const path of ['/cost', '/unknown', '/missing', '/drift', '/permit', '/historical']) {
      const response = await mf.dispatchFetch(`http://localhost${path}`);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      if (path === '/cost') {
        console.log(JSON.stringify(result));
        assert.ok(result.triggers > 100);
        assert.ok(result.install < 10000, `install scanned ${result.install} rows`);
        assert.ok(result.verify < 10000, `verify scanned ${result.verify} rows`);
      } else assert.equal(result.protected, true);
    }
  } finally { await mf.dispose(); }
});
