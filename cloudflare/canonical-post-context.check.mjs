import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Workers work-ref canonical post and inactive Guide avoid full-room hydration and survive cold reopen', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./canonical-post-context.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'CanonicalPostContextTestRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' } });
  try {
    const response = await runtime.dispatchFetch('https://room.example.test/');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { wholeRoomReads: 0, corruptSkipRefused: true, corruptWorkRefused: true, workUnchanged: true, count: 2, hasArray: false, bodies: ['Body first', 'Body second'] });
  } finally { await runtime.dispose(); }
});
