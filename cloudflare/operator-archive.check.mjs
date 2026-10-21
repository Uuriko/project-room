import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// r59: the legacy-shape upgrade and the operator archive door (r58) under
// workerd's SQLite Durable Object storage. node:sqlite tests cover the logic;
// only a Worker run shows the Durable Object open path and its storage.
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./operator-archive.test-fixture.mjs', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
const worker = (persistence, messages) => new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], bindings: { ARCHIVE_MESSAGES: messages },
  durableObjects: { ROOM: { className: 'ArchiveRoom', useSQLite: true } }, durableObjectsPersist: persistence });
async function timed(mf, path) {
  const t0 = performance.now(); const res = await mf.dispatchFetch('http://localhost' + path); const text = await res.text();
  assert.equal(res.status, 200, text.slice(0, 1500));
  return { ms: Math.round(performance.now() - t0), ...JSON.parse(text) };
}

test('Worker SQLite, same instance: legacy shapes refuse the archive until the upgrade runs, then it archives', async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'room-archive-'));
  const mf = worker(persistence, 700);
  try {
    const seeded = await timed(mf, '/seed');
    assert.deepEqual(seeded.legacy, { cardMissingReceiptId: true, m1HasReactions: true });
    const early = await timed(mf, '/plan');
    assert.equal(early.status, 409, JSON.stringify(early));
    assert.equal(early.code, 'archive_not_ready');
    assert.match(early.message, /parity_failed/);
    const upgraded = await timed(mf, '/upgrade');
    assert.deepEqual(upgraded.result, { rooms: 1, reactionsRemoved: 1, receiptIdsAdded: 1 });
    const archived = await timed(mf, '/archive');
    assert.equal(archived.done.status, 200, JSON.stringify(archived.done));
    assert.equal(archived.messagesLeft, 500);
    assert.ok(archived.after < archived.before, `projection ${archived.before} -> ${archived.after}`);
    console.log('R59_SAME ' + JSON.stringify({ seeded, early: { code: early.code, ms: early.ms }, upgraded: upgraded.result,
      archive: { ms: archived.ms, before: archived.before, after: archived.after, ...archived.done.body } }));
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});

test('Worker SQLite, cold start: the Durable Object open path upgrades legacy shapes, and the archive door then catches up and archives', async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'room-archive-cold-'));
  const messages = Number(process.env.R59_MESSAGES ?? 3000);
  try {
    const first = worker(persistence, messages);
    let seeded;
    try { seeded = await timed(first, '/seed'); } finally { await first.dispose(); }
    assert.deepEqual(seeded.legacy, { cardMissingReceiptId: true, m1HasReactions: true });
    // A deploy restarts every Durable Object: a fresh instance on the same storage.
    const second = worker(persistence, messages);
    try {
      const state = await timed(second, '/state');
      assert.deepEqual(state.legacy, { cardMissingReceiptId: false, m1HasReactions: false }, JSON.stringify(state));
      assert.deepEqual(state.audit, [{ target: 'projection', reactions_removed: 1, receipt_ids_added: 1 }]);
      const archived = await timed(second, '/archive');
      assert.equal(archived.plan.status, 200, JSON.stringify(archived.plan));
      assert.equal(archived.done.status, 200, JSON.stringify(archived.done));
      assert.ok(archived.after < archived.before);
      console.log('R59_COLD ' + JSON.stringify({ messages, seedMs: seeded.ms, seedBytes: seeded.projectionBytes, stateMs: state.ms,
        archive: { ms: archived.ms, before: archived.before, after: archived.after, ...archived.done.body } }));
    } finally { await second.dispose(); }
  } finally { await rm(persistence, { recursive: true, force: true }); }
});
