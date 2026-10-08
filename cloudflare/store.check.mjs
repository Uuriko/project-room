// Run explicitly; this suite requires the isolated Cloudflare dev dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('human push uses real Worker crypto and committed Durable Object state with a synthetic delivery service', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./store-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'StoreTestRoom', useSQLite: true } } });
  try {
    const response = await mf.dispatchFetch('http://localhost/human-push');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { defaultOff: true, encrypted: true, rollbackSuppressed: true });
  } finally { await mf.dispose(); }
});

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
    for (const path of ['/update-ack', '/update-ack-resume']) {
      await mf.dispose(); mf = new Miniflare(config);
      const update = await mf.dispatchFetch('http://localhost' + path, { method: 'POST', body: JSON.stringify(receipt) });
      assert.equal(update.status, 200, await update.clone().text());
      assert.deepEqual(await update.json(), { acknowledgmentRecovered: true, reviewed: false, canSend: false });
    }
    for (const path of ['/update-inspect', '/update-review', '/update-reviewed-resume']) {
      await mf.dispose(); mf = new Miniflare(config);
      const update = await mf.dispatchFetch('http://localhost' + path, { method: 'POST', body: JSON.stringify(receipt) });
      assert.equal(update.status, 200, await update.clone().text());
      assert.deepEqual(await update.json(), { inspectionRecovered: true, reviewed: path !== '/update-inspect', canSend: false });
    }
    for (const path of ['/update-read-unavailable', '/update-unavailable-resume']) {
      await mf.dispose(); mf = new Miniflare(config);
      const update = await mf.dispatchFetch('http://localhost' + path, { method: 'POST', body: JSON.stringify(receipt) });
      assert.equal(update.status, 200, await update.clone().text());
      assert.deepEqual(await update.json(), { latestUnavailable: true, preservedLocal: true });
    }
    const guard = await mf.dispatchFetch('http://localhost/newer-version');
    assert.equal(guard.status, 200, await guard.clone().text());
    assert.deepEqual(await guard.json(), { rejected: true });
    console.log('Synthetic shared-store restart evidence retained at', persistence);
  } finally { await mf.dispose(); }
});

// Node SQLite exposes lastInsertRowid; DurableDatabase does not. Exercise the
// real adapter and a fresh workerd instance so a committed broken chain cannot hide.
test('membership delegation grant, revoke and regrant retain journal integrity after Worker restart', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./store-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'project-room-cf-delegation-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'StoreTestRoom', useSQLite: true } }, durableObjectsPersist: persistence };
  let mf = new Miniflare(config);
  try {
    const response = await mf.dispatchFetch('http://localhost/delegation');
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json(); // Synthetic credential stays in memory.
    await mf.dispose();
    mf = new Miniflare(config);
    const resumed = await mf.dispatchFetch('http://localhost/delegation-resume', { method: 'POST', body: JSON.stringify(receipt) });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.deepEqual(await resumed.json(), { recovered: true, entries: 4, active: false });
  } finally { await mf.dispose(); }
});

test('bounty draft receipts match durable event sequences and replay after Worker restart', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./store-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'project-room-cf-bounty-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'StoreTestRoom', useSQLite: true } }, durableObjectsPersist: persistence };
  let mf = new Miniflare(config);
  try {
    const response = await mf.dispatchFetch('http://localhost/bounty-receipts');
    assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    assert.deepEqual(receipt, { sequences: [2, 3], drafts: 2 });
    await mf.dispose(); mf = new Miniflare(config);
    const resumed = await mf.dispatchFetch('http://localhost/bounty-receipts-resume');
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.deepEqual(await resumed.json(), receipt);
  } finally { await mf.dispose(); }
});

// Distinct platform risk: native nested rollback, writer permit and cache ownership.
test('explicit isolated RoomStore writes roll back independently on real Workers', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./store-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'StoreTestRoom', useSQLite: true } } });
  try {
    const response = await mf.dispatchFetch('http://localhost/isolated-transactions');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { innerRolledBack: true, parentPreserved: true, outerRollback: true, cacheRestored: true, defaultsPreserved: true, readOnlyProtected: true, synchronous: true });
  } finally { await mf.dispose(); }
});

// H2 backup/DR: a whole-store NDJSON export replays into a pristine Durable
// Object on real Workers SQLite, and a second replay into the now-live DO is
// refused instead of overwriting. This is the platform boundary the node
// suite cannot reach: PRAGMA behavior, the writer-fence permit dance, and
// DurableDatabase all run for real here.
test('whole-store NDJSON restore replays into a pristine Durable Object and refuses a live one', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./store-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'project-room-cf-restore-'));
  const config = { modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'StoreTestRoom', useSQLite: true } }, durableObjectsPersist: persistence };
  const mf = new Miniflare(config);
  try {
    const seed = await mf.dispatchFetch('http://localhost/restore-drill/seed', { method: 'POST' });
    assert.equal(seed.status, 200, await seed.clone().text());
    const { ndjson } = await seed.json();
    assert.match(ndjson, /"kind":"watermark"/, 'seed exports the whole-store NDJSON format');
    const replay = await mf.dispatchFetch('http://localhost/restore-drill-fresh', { method: 'POST', body: ndjson });
    assert.equal(replay.status, 200, await replay.clone().text());
    const result = await replay.json();
    assert.equal(result.ok, true, `replay failed: ${result.error ?? 'unknown'}`);
    assert.equal(result.verified, true);
    assert.ok(result.events > 0 && result.tables > 0, 'replay reports what it restored');
    const again = await mf.dispatchFetch('http://localhost/restore-drill-fresh', { method: 'POST', body: ndjson });
    const refused = await again.json();
    assert.equal(refused.ok, false, 'second replay into the live DO must not succeed');
    assert.match(refused.error ?? '', /non-empty/i, 'refusal names the fail-closed rule');
  } finally { await mf.dispose(); }
});
