// Workerd proof that cron RPC reaches ProjectRoom. A Proxy stub that answers
// every method name cannot see this failure: workerd rejects the call when
// the class does not extend DurableObject, or when the method is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('paused ProjectRoom cron methods run inside workerd, and an unknown method does not', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./scheduled-rpc.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['node:*', 'cloudflare:*']
  });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: '1' }
  });
  try {
    const scheduled = await mf.dispatchFetch(origin + '/scheduled');
    assert.equal(scheduled.status, 200, await scheduled.clone().text());
    assert.deepEqual(await scheduled.json(), { scheduled: true });

    const response = await mf.dispatchFetch(origin + '/rpc');
    assert.equal(response.status, 200, await response.clone().text());
    const results = await response.json();
    assert.deepEqual(results.syncGmailMailboxes, { ok: true, value: { completed: 0 } });
    assert.deepEqual(results.refreshLandQueue, { ok: true, value: { checked: 0, updated: 0, unconfigured: 0 } });
    assert.deepEqual(results.refreshClaimPullRequests, { ok: true, value: { checked: 0, updated: 0 } });
    assert.deepEqual(results.planRetention, { ok: true, value: { dryRun: true, deleted: 0, skipped: 'paused' } });
    assert.deepEqual(results.backfillPublicReadModel, { ok: true, value: { done: false, skipped: 'paused', rooms: 0, receipts: 0, cards: 0 } });
    assert.equal(results.drainChannelBacklog.ok, false);
    assert.match(results.drainChannelBacklog.message, /Room paused/);
    assert.equal(results.drainWebhookDeliveries.ok, false);
    assert.match(results.drainWebhookDeliveries.message, /Room paused/);
    assert.deepEqual(results.notARealCronMethod, {
      ok: false,
      message: 'The RPC receiver does not implement the method "notARealCronMethod".'
    });
  } finally {
    await mf.dispose();
  }
});

// The paused RPC smoke check cannot exercise storage. This owns the real
// unpaused retention boundary: one table per tick, operator dry-run, and
// rollback of the table whose delete fails.
test('unpaused retention RPC applies one table per tick and rolls that table back on failure', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./scheduled-rpc.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
  });
  const origin = 'https://room.example.test';
  const start = bindings => new Miniflare({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'RetentionTestRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: '0', ...bindings }
  });
  const dry = start({ ROOM_RETENTION_ALLOW_DELETION: '0' });
  try {
    const call = async path => {
      const response = await dry.dispatchFetch(origin + '/retention/' + path);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const before = await call('seed');
    const receipt = await call('run');
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.table, 'web_fetch_log');
    assert.equal(receipt.deleted, 0);
    assert.equal(receipt.categories.web_fetch_log.eligible, 1);
    assert.deepEqual(await call('counts'), before);
  } finally { await dry.dispose(); }

  const mf = start({});
  try {
    const call = async path => {
      const response = await mf.dispatchFetch(origin + '/retention/' + path);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const before = await call('seed');
    await call('fail');
    const fetchRun = await call('run');
    assert.equal(fetchRun.dryRun, false);
    assert.equal(fetchRun.table, 'web_fetch_log');
    assert.equal(fetchRun.deleted, 1);
    assert.equal(fetchRun.webhookDeliveries.deleted, 0);
    const failed = await mf.dispatchFetch(origin + '/retention/run');
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /retention fixture failure/);
    assert.deepEqual(await call('counts'), { fetch: 1, research: before.research, events: before.events });
    await call('recover');
    const researchRun = await call('run');
    assert.equal(researchRun.table, 'web_research_log');
    assert.equal(researchRun.deleted, 1);
    assert.deepEqual(await call('counts'), { fetch: 1, research: 1, events: before.events });
    assert.equal((await call('run')).deleted, 0);
  } finally { await mf.dispose(); }
});
