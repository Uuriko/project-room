import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// SPILL-1: the messages-archive job under workerd's SQLite Durable
// Object storage. node:sqlite tests (tests/messages-archive.test.js)
// cover the policy; only a Worker run shows the tick certifying and
// archiving against the DO's own store — the worker door's production
// shape — and the reader surface answering identically across it.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./messages-archive.test-fixture.mjs', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
});
const worker = persistence => new Miniflare({
  modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { ROOM: { className: 'ArchiveJobRoom', useSQLite: true } }, durableObjectsPersist: persistence
});
async function call(mf, path) {
  const res = await mf.dispatchFetch('http://localhost' + path);
  const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 1500));
  return JSON.parse(text);
}

test('Worker SQLite: the archive tick is dry by default, archives one room live, and reads do not change', async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'room-archive-job-'));
  const mf = worker(persistence);
  try {
    const seeded = await call(mf, '/seed?count=2100');
    assert.equal(seeded.messages, 2100);
    assert.ok(seeded.projectionBytes > 1_048_576, `seeded room is over the archive trigger (${seeded.projectionBytes})`);

    const dry = await call(mf, '/tick');
    assert.equal(dry.dryRun, true);
    assert.equal(dry.archived, 0);
    assert.equal(dry.marker, false);
    assert.equal(dry.projectionBytes, seeded.projectionBytes, 'the dry tick moved no bytes');
    assert.deepEqual(dry.due, ['archive-job-room']);

    const before = await call(mf, '/capture');
    assert.equal(before.count, 2100);
    assert.equal(before.first.id, 'seed-0');

    const live = await call(mf, '/tick?live=1');
    assert.equal(live.dryRun, false);
    assert.equal(live.roomId, 'archive-job-room');
    assert.equal(live.archived, 100);
    assert.equal(live.messages, 2000);
    assert.equal(live.marker, true);
    assert.ok(live.projectionBytes < seeded.projectionBytes, `projection ${seeded.projectionBytes} -> ${live.projectionBytes}`);

    const after = await call(mf, '/capture');
    assert.deepEqual(after, before, 'the reader surface is identical across the archive');
    console.log('SPILL1_WORKERD ' + JSON.stringify({ seeded: seeded.projectionBytes, after: live.projectionBytes, archived: live.archived }));
  } finally {
    await mf.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
});
