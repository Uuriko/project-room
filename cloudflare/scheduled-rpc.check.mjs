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
    assert.deepEqual(results.planRetention, { ok: true, value: { dryRun: true, deleted: 0, skipped: 'paused' } });
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
