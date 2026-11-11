import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Workers installed native mention subscribes, delivers without room hydration and refuses corrupt proof', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./native-mention-context.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'NativeMentionContextTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: 'https://room.example' } });
  try {
    const response = await runtime.dispatchFetch('https://room.example/');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { fullRoomReads: 0, challenges: 1, callbacks: 1, delivered: 'delivered', corruptionState: 'pending', retryDuplicate: true, coldMessageCount: 34 });
  } finally { await runtime.dispose(); }
});
