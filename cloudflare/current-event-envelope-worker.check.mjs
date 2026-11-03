import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual Worker projects bounded historical message envelopes before unrelated HTTP catch-up, including cold reopen', async () => {
  const built = await build({ entryPoints: [fileURLToPath(new URL('./current-event-envelope-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const directory = await mkdtemp(join(tmpdir(), 'event-envelope-worker-'));
  const create = () => new Miniflare({ durableObjectsPersist: directory, modules: true, script: built.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'EventEnvelopeRoom', useSQLite: true } } });
  let mf = create();
  const call = async path => (await mf.dispatchFetch('http://localhost' + path)).json();
  const samples = [];
  try {
    for (const kind of ['CJK', 'astral', 'controls']) {
      const seed = await call('/seed?kind=' + kind);
      const first = await call(`/consume?kind=${kind}&after=${seed.openingSequence - 1}`);
      const warm = await call(`/consume?kind=${kind}&after=${seed.openingSequence - 1}`);
      console.log('EVENT_ENVELOPE_ATOMS ' + JSON.stringify({ kind, seed, first: first.cost, warm: warm.cost }));
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.deepEqual(first.page.directMessages, []);
      assert.equal(first.page.cursor.after, seed.openingSequence);
      assert.equal(first.page.cursor.hasMore, true);
      assert.ok(!JSON.stringify(first.page).includes('large-private'));
      for (const result of [first, warm]) {
        assert.equal(result.cost.rawEventSourceBytes, seed.rawBytes, 'Only one large raw source atom is processed');
        assert.ok(result.cost.projectedEventBytesReturned < 1024);
        assert.equal(result.cost.historicalSqlPayloads, 0, 'The raw historical body must not cross SQLite to JS');
        assert.equal(result.cost.rowsWritten, 0);
        assert.equal(result.cost.rawRuntimeRowsWritten, 0);
      }
      const second = await call(`/consume?kind=${kind}&after=${first.page.cursor.after}`);
      assert.equal(second.status, 200, JSON.stringify(second));
      assert.deepEqual(second.page.directMessages.map(row => [row.messageId, row.body]), [['later-visible', 'Later unrelated obligation']]);
      assert.equal(second.page.cursor.hasMore, false);
      samples.push({ kind, openingSequence: seed.openingSequence, rawBytes: seed.rawBytes, cold: first.cost, warm: warm.cost });
    }
    await mf.dispose(); mf = create();
    for (const sample of samples) {
      const cold = await call(`/consume?kind=${sample.kind}&after=${sample.openingSequence - 1}`);
      assert.equal(cold.status, 200, JSON.stringify(cold));
      assert.equal(cold.cost.rawEventSourceBytes, sample.rawBytes);
      assert.equal(cold.cost.historicalSqlPayloads, 0);
      assert.deepEqual(cold.page.directMessages, []);
      sample.restartCold = cold.cost;
    }
    console.log('EVENT_ENVELOPE_WORKER ' + JSON.stringify({ samples,
      accounting: 'rawEventSourceBytes bounds raw SQL JSON work; projectedEventBytesReturned measures effective JS input. SQL rowsRead is native physical work, not wire bytes.' }));
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
