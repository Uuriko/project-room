import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createRuntimePackage } from '../scripts/runtime-package.mjs';
test('Worker upgrades real v30 data and fences its old request writer', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'request-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const destination = join(directory, 'old');
  createRuntimePackage({ repository: fileURLToPath(new URL('../', import.meta.url)), commit: '6ebf919000da8741b17c6491327e9bf7bf791978', destination });
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./request-run.test-fixture.mjs', import.meta.url))], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'], plugins: [{ name: 'frozen-runtime', setup(build) {
      build.onResolve({ filter: /^old-runtime-/ }, args => ({ path: join(destination, args.path === 'old-runtime-store' ? 'server/store.mjs' : 'cloudflare/storage.mjs') }));
    } }] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { RUN: { className: 'RequestRunExperiment', useSQLite: true } } });
  try {
    const response = await mf.dispatchFetch('http://localhost/test');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { upgraded: true, oldWriterBlocked: true, claimed: true });
  } finally { await mf.dispose(); }
});
