import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('a queued Durable Object read runs between due jobs', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./job-fairness.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['node:*', 'cloudflare:*']
  });
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'FairnessProbe', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test', ROOM_GMAIL_ENABLED: '1' }
  });
  try {
    const seeded = await mf.dispatchFetch('https://room.example.test/seed');
    assert.equal(seeded.status, 200);
    const response = await mf.dispatchFetch('https://room.example.test/run');
    assert.equal(response.status, 200);
    const trace = await response.json();
    assert.deepEqual(trace, ['first-job', 'read', 'second-job']);
  } finally {
    await mf.dispose();
  }
});
