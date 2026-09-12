import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('shared attachment staging uses the real DurableDatabase transaction and binary adapter', { timeout: 60000 }, async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./attachment-staging.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FILES: { className: 'AttachmentStagingExperiment', useSQLite: true } } });
  try {
    const response = await mf.dispatchFetch('http://localhost/scenario');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { sharedAdapter: true, slice: true, retry: true, rollback: true, discard: true });
  } finally { await mf.dispose(); }
});
