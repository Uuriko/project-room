import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('retention reads stay bounded as telemetry and webhook tables grow', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./retention-bounds.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
  });
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'Profile', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.example.test' }
  });
  try {
    const cursorResponse = await mf.dispatchFetch('https://room.example.test/cursor');
    assert.equal(cursorResponse.status, 200);
    const cursor = await cursorResponse.json();
    assert.equal(cursor.first.examined, 500);
    assert.equal(cursor.first.deleted, 0);
    assert.deepEqual(cursor.checkpoint, cursor.first.nextCursor);
    assert.equal(cursor.failed, true);
    assert.deepEqual(cursor.afterFailure, cursor.checkpoint, 'failed SQL batch cannot advance durable cursor');
    assert.equal(cursor.second.deleted, 20, 'Worker resumes durable checkpoint even with empty process-local cursor');
    assert.equal(cursor.afterSuccess, null);
    assert.equal(cursor.reset.examined, 500, 'malformed durable checkpoint safely restarts the bounded sweep');
    const spreadResponse = await mf.dispatchFetch('https://room.example.test/?n=1000&terminal=1&spread=1');
    assert.equal(spreadResponse.status, 200);
    const spread = await spreadResponse.json();
    console.log('retention-bounds-distinct-subscriptions', JSON.stringify(spread));
    assert.equal(spread.examined, 500);
    assert.equal(spread.webhookDeleted, 500);
    assert.ok(spread.webhookRowsRead < 52_000, 'at most 100 indexed threshold entries per each of 500 subscriptions');
    for (const terminal of [false, true]) {
      const results = [];
      for (const n of [1000, 10000]) {
        const response = await mf.dispatchFetch(`https://room.example.test/?n=${n}&terminal=${Number(terminal)}`);
        assert.equal(response.status, 200);
        const result = await response.json();
        console.log('retention-bounds', JSON.stringify(result));
        assert.equal(result.eligible, 100);
        assert.ok(result.logRowsRead <= 250, 'global telemetry age index bounds the scan');
        assert.ok(terminal ? result.webhookDeleted >= 400 && result.webhookDeleted <= 500 : result.webhookDeleted === 0);
        assert.equal(result.examined, terminal ? 500 : 0);
        assert.ok(result.webhookRowsRead < 5000, 'single-subscription candidate and cached newest-100 reads are bounded');
        results.push(result);
      }
      assert.ok(results[1].webhookRowsRead <= results[0].webhookRowsRead + 100);
    }
  } finally { await mf.dispose(); }
});
