import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Authoring gate: real Worker SQLite v37 permit/fence/column migration and
// restart, which Node cannot prove. Content/privacy cases stay at their Node
// storage owner; no production test seam and no permissive platform double.
test('Worker SQLite upgrades v37 message storage, preserves records and redacts replay state', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./messages-fidelity.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'room-message-fidelity-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'MessageFidelityRoom', useSQLite: true } }, durableObjectsPersist: persistence };
  let mf = new Miniflare(config);
  try {
    const seeded = await mf.dispatchFetch('http://localhost/seed-v37');
    assert.equal(seeded.status, 200, await seeded.clone().text());
    const receipt = await seeded.json();
    await mf.dispose();
    mf = new Miniflare(config);
    const resumed = await mf.dispatchFetch('http://localhost/resume-v38', { method: 'POST', body: JSON.stringify(receipt) });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.deepEqual(await resumed.json(), { migrated: true, recordPreserved: true, deleted: true });
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
