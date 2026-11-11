import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual Workers admit optional index boundaries, preserve rollback/retry and reduce terminal quota work', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./attachment-live-index.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'attachment-index-worker-'));
  const worker = () => new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'AttachmentIndexProbe', useSQLite: true } }, durableObjectsPersist: persistence });
  let mf = worker();
  const call = async (path, input = {}, status = 200, fixture = 'boundary') => {
    const response = await mf.dispatchFetch('http://localhost' + path + '?fixture=' + fixture, { method: 'POST', body: JSON.stringify(input) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  try {
    await call('/seed-cost', {}, 200, 'cost');
    const before = await call('/stage', { id: 'before' }, 200, 'cost');
    const costPlan = await call('/plan', {}, 200, 'cost'); await call('/execute', { planHash: costPlan.planHash, requestId: 'cost-install' }, 200, 'cost');
    const after = await call('/stage', { id: 'after' }, 200, 'cost');
    assert.ok(after.costs.quota < before.costs.quota / 4); assert.ok(after.costs.quota < 32);
    console.log(JSON.stringify({ fixture: 'runtime-attachment-expiry', before: before.costs, after: after.costs, beforePlan: before.expiryPlan, afterPlan: after.expiryPlan }));
  assert.ok(Number.isSafeInteger(before.costs.expiry) && Number.isSafeInteger(after.costs.expiry));
  assert.ok(after.costs.expiry < before.costs.expiry / 4);
  assert.ok(after.costs.expiry < 32);
  assert.ok(after.expiryPlan.some(row => row.detail.includes('room_attachments_live')));
    console.log(JSON.stringify({ fixture: 'runtime-attachment-stage', before: before.costs, after: after.costs }));
    const seeded = await call('/seed-boundary');
    const plan = await call('/plan');
    assert.deepEqual(plan.admitted, { rows: 32768, keyBytes: 4194304, storedBytes: 67108864 });
    const state = await call('/state'); assert.equal(state.installed, 'absent');
    for (const [change, restore] of [['/over-row', '/restore-row'], ['/over-key', '/restore-key'], ['/stored-plus-one', '/stored-restore']]) {
      await call(change);
      const sizes = await call('/sizes'), limits = { rows: 32768, keyBytes: 4194304, storedBytes: 67108864 };
      const exceeded = Object.keys(limits).filter(key => sizes[key] > limits[key]);
      assert.deepEqual(exceeded, [change === '/over-row' ? 'rows' : change === '/over-key' ? 'keyBytes' : 'storedBytes']);
      const refused = await call('/plan', {}, 409);
      assert.equal(refused.error.code, 'attachment_index_budget_exceeded'); assert.equal(refused.keyReads, state.keyReads); assert.equal(refused.builds, 0);
      await call(restore);
    }
    await call('/fault'); await call('/execute', { planHash: plan.planHash, requestId: 'boundary-install' }, 500);
    assert.equal((await call('/state')).installed, 'absent'); await call('/unfault');
    await call('/fault-critical');
    const critical = await call('/execute', { planHash: plan.planHash, requestId: 'boundary-install' }, 503);
    assert.equal(critical.error.code, 'storage_unavailable'); await call('/unfault-critical');
    assert.equal((await call('/state')).installed, 'absent');
    const installed = await call('/execute', { planHash: plan.planHash, requestId: 'boundary-install' }); assert.equal(installed.result.installed, true);
    const installedState = await call('/state'); assert.equal(installedState.rows, 32768); assert.equal(installedState.stamp, state.stamp);
    console.log(JSON.stringify({ fixture: 'combined-admission-boundary', seed: seeded, admitted: plan.admitted, plan: plan.measured, install: installed.measured }));
    await mf.dispose(); mf = worker();
    const resumed = await call('/state'); assert.equal(resumed.installed, 'installed'); assert.equal(resumed.builds, 0); assert.equal(resumed.stamp, state.stamp);
    const retry = await call('/execute', { planHash: plan.planHash, requestId: 'boundary-install' }); assert.equal(retry.duplicate, true); assert.equal(retry.measured.keyReads, 0); assert.equal(retry.measured.builds, 0);
    assert.equal((await call('/execute', { planHash: plan.planHash, requestId: 'boundary-install', reverse: true }, 409)).error.code, 'idempotency_conflict');
    const reverse = await call('/plan', { reverse: true });
    await call('/fault'); await call('/execute', { reverse: true, planHash: reverse.planHash, requestId: 'boundary-reverse' }, 500);
    assert.equal((await call('/state')).installed, 'installed'); await call('/unfault');
    const reversed = await call('/execute', { reverse: true, planHash: reverse.planHash, requestId: 'boundary-reverse' });
    assert.equal(reversed.result.installed, false); assert.equal((await call('/state')).rows, 32768);
    console.log(JSON.stringify({ fixture: 'bounded-index-reverse', measured: reversed.measured }));
    await mf.dispose(); mf = worker();
    const absent = await call('/state'); assert.equal(absent.installed, 'absent'); assert.equal(absent.builds, 0); assert.equal(absent.keyReads, 0); assert.equal(absent.stamp, state.stamp);
    assert.equal((await call('/plan')).installed, false, 'a schema stamp does not certify optional index presence');
    const historical = await call('/execute', { planHash: plan.planHash, requestId: 'boundary-install' });
    assert.equal(historical.duplicate, true); assert.equal(historical.result.installed, true);
    assert.equal((await call('/state')).installed, 'absent', 'historical success does not reinstall after explicit reversal');
  } finally { await mf.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
