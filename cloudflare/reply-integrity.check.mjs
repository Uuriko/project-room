import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Workers reply integrity reuses unchanged reads and invalidates DDL and corruption', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./reply-integrity.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ReplyIntegrityRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
  try {
    const response = await mf.dispatchFetch('https://room.example.test/__integrity', {
      headers: { Host: 'room.example.test', 'CF-Connecting-IP': '192.0.2.1' } });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    assert.deepEqual(value, { first: 1, second: 1, afterDdl: 2, refused: true, finalScans: 3 });
  } finally { await mf.dispose(); }
});
