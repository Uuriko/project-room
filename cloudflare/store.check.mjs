// Run explicitly; this suite requires the isolated Cloudflare dev dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('shared RoomStore: guests, retries, messages, journal rollback, cancellation and restart on Workers', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./store-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'project-room-cf-store-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'StoreTestRoom', useSQLite: true } }, durableObjectsPersist: persistence };
  let mf = new Miniflare(config);
  try {
    const scenario = await mf.dispatchFetch('http://localhost/scenario');
    assert.equal(scenario.status, 200, await scenario.clone().text());
    const receipt = await scenario.json(); // Synthetic credentials stay in test memory; never logged.
    await mf.dispose();
    mf = new Miniflare(config);
    const resumed = await mf.dispatchFetch('http://localhost/resume', { method: 'POST', body: JSON.stringify(receipt) });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.deepEqual(await resumed.json(), { recovered: true, guests: 2, sequence: receipt.sequence });
    await mf.dispose(); mf = new Miniflare(config);
    const review = await mf.dispatchFetch('http://localhost/review-resume', { method: 'POST', body: JSON.stringify(receipt) });
    assert.equal(review.status, 200, await review.clone().text());
    assert.deepEqual(await review.json(), { reviewRecovered: true, invalidated: true, canSend: false });
    for (const path of ['/update-resume', '/update-evidence-resume']) {
      await mf.dispose(); mf = new Miniflare(config);
      const update = await mf.dispatchFetch('http://localhost' + path, { method: 'POST', body: JSON.stringify(receipt) });
      assert.equal(update.status, 200, await update.clone().text());
      assert.deepEqual(await update.json(), { updateRecovered: true, outcome: 'unproven', canSend: false });
    }
    const guard = await mf.dispatchFetch('http://localhost/newer-version');
    assert.equal(guard.status, 200, await guard.clone().text());
    assert.deepEqual(await guard.json(), { rejected: true });
    console.log('Synthetic shared-store restart evidence retained at', persistence);
  } finally { await mf.dispose(); }
});
