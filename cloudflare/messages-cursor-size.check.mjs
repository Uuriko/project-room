import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Worker SQLite refuses an oversized row (workerd: 2,200,000 B up to
// v1.20260819, 4 MiB from v1.20260820.1, 8 MiB + 34 B from v1.20260925.1;
// Cloudflare's docs say 2 MB). node:sqlite has no such limit, so only a
// Worker run shows a room whose replay state outgrows one row.
const ROW_LIMIT_8MIB = 8 * 1024 * 1024 + 34;
const DOCUMENTED_ROW_LIMIT = 2_000_000;

async function backfillCursorRoom(messages) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./messages-cursor-size.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'room-cursor-size-'));
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], bindings: { CURSOR_MESSAGES: messages },
    durableObjects: { ROOM: { className: 'CursorSizeRoom', useSQLite: true } }, durableObjectsPersist: persistence });
  try {
    const seeded = await mf.dispatchFetch('http://localhost/seed');
    assert.equal(seeded.status, 200, await seeded.clone().text());
    const filled = await mf.dispatchFetch('http://localhost/backfill');
    assert.equal(filled.status, 200, (await filled.clone().text()).slice(0, 1500));
    return await filled.json();
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
}

test('Worker SQLite certifies a room whose message text is over the row limit', async () => {
  const receipt = await backfillCursorRoom(40);
  assert.equal(receipt.certified, true);
  assert.equal(receipt.rows, 40);
});

// muse-room's replay state passes 8 MiB + 34 B near seq 13,100 (r54 replay of
// the prod log), so the parts path must hold above the newest runtime limit,
// with every part under the documented 2 MB.
test('Worker SQLite certifies a room whose replay state is over 8 MiB', async () => {
  const receipt = await backfillCursorRoom(150);
  assert.equal(receipt.certified, true);
  assert.equal(receipt.rows, 150);
  assert.ok(receipt.stateBytes > ROW_LIMIT_8MIB, `state is ${receipt.stateBytes} bytes`);
  assert.ok(receipt.cursorBytes < DOCUMENTED_ROW_LIMIT, `largest part is ${receipt.cursorBytes} bytes`);
});
