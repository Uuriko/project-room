import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual AgentHeartbeats work delivery bounds examined backlog before filtering', async t => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./work-wake-input-budget.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'WorkWakeBudgetProbe', useSQLite: true } } });
  t.after(() => mf.dispose());
  const observations = [];
  for (const kind of ['opted-out', 'stale', 'messages']) for (const count of [1000, 10000]) {
    const response = await mf.dispatchFetch('http://localhost/' + kind + count, { method: 'POST', body: JSON.stringify({ count, kind }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); observations.push(result); console.log(JSON.stringify(result));
  }
  for (const result of observations) {
    assert.deepEqual(result.signals, [{ kind: 'work', workItemId: 'task', workRevision: 0, action: 'accept', nextRead: { tool: 'room_read_work', arguments: { roomId: 'commons', workItemId: 'task' } } }]);
    assert.equal(result.more, false); assert.equal(result.nextCursor, null);
    if (result.controls) assert.deepEqual(result.controls, { optedOut: 0, paused: 0, quiet: 0, restored: 1, removed: 0 });
  }
  for (const result of observations) { assert.ok(result.selected <= 258); for (const plan of result.plans.flat()) { assert.match(plan, /USING (?:COVERING )?INDEX agent_(?:work_wakes|wake_signals)_ordered_(?:room_)?pending/); assert.doesNotMatch(plan, /TEMP B-TREE|SCAN /); } assert.ok(result.totalRowsRead < 600, 'physical reads per page must remain bounded'); if (result.kind === 'messages') { assert.equal(result.emptyMorePages, 0); assert.equal(result.pages, 1); } else assert.ok(result.emptyMorePages > 0); }
  for (let n = 0; n < observations.length; n += 2) assert.equal(observations[n].totalRowsRead, observations[n + 1].totalRowsRead, 'per-page reads must not grow with backlog');
});

test('actual Worker cold restart preserves activation and oversized pointer refuses before payload', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./work-wake-input-budget.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'wake-index-worker-'));
  const worker = () => new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'WorkWakeBudgetProbe', useSQLite: true } }, durableObjectsPersist: persistence });
  let mf = worker();
  const call = async (path, input = {}) => {
    const response = await mf.dispatchFetch('http://localhost' + path + '?fixture=restart', { method: 'POST', body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await call('/seed', { count: 1000, kind: 'stale' })).status, 200);
    await mf.dispose(); mf = worker();
    const cold = await call('/read'), warm = await call('/read');
    assert.equal(cold.status, 200); assert.equal(warm.status, 200);
    assert.deepEqual(cold.value.page, warm.value.page); assert.equal(cold.value.page.more, true);
    assert.ok(cold.value.rowsRead - warm.value.rowsRead <= cold.value.catalogRows + 10, 'one cold catalog discovery, followed by exact tuple point reads');
    assert.ok(warm.value.rowsRead < 600);
    const reinstalled = await call('/reinstall'); assert.equal(reinstalled.status, 200);
    assert.deepEqual(reinstalled.value, { interrupted: true, rolledBack: true, installed: true, repairDuplicate: true, originalDuplicate: true, originalUnchanged: true, repairRetryUnchanged: true });
    const oversized = await call('/oversize'); assert.equal(oversized.status, 503); assert.deepEqual(oversized.value, { code: 'storage_unavailable', payloadReads: 0 });
    console.log(JSON.stringify({ coldRowsRead: cold.value.rowsRead, warmRowsRead: warm.value.rowsRead, catalogRows: cold.value.catalogRows, oversized: oversized.value }));
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});

test('actual Worker inactive repeated polls preserve legacy delivery without catalog scans', async t => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./work-wake-input-budget.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'WorkWakeBudgetProbe', useSQLite: true } } });
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('http://localhost/inactive', { method: 'POST', body: JSON.stringify({ count: 0, kind: 'inactive' }) });
  const result = await response.json(); assert.equal(response.status, 200); console.log(JSON.stringify({ inactive: result }));
  for (const poll of result.polls) {
    assert.equal(poll.page.signals.length, 1); assert.equal(poll.page.signals[0].workItemId, 'task');
    assert.equal(poll.page.more, false); assert.equal(poll.page.nextCursor, null);
    assert.equal(poll.catalogStatements, 0, 'support-only polling must not inspect optional indexes');
    assert.equal(poll.catalogReads, 0);
  }
});
