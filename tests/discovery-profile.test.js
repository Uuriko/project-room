import test from 'node:test';
import assert from 'node:assert/strict';
import { profileDiscovery } from '../scripts/discovery-profile.mjs';

test('discovery transfer measurement counts identity reads and separates result size from snapshot cost', async () => {
  const small = await profileDiscovery({ workCount: 4, messageCount: 4, samples: 1 });
  const chat = await profileDiscovery({ workCount: 4, messageCount: 40, samples: 1 });
  for (const profile of [small, chat]) {
    assert.equal(profile.roomAuditUnchanged, true);
    for (const metric of Object.values(profile.metrics)) {
      assert.equal(metric.requestsPerRead, 2); assert.equal(metric.identityChecksPerRead, 1);
      assert.ok(metric.decodedBodyBytes.min > 0); assert.ok(metric.resultJsonBytes.min > 0);
    }
  }
  // The full snapshot is the control. Do not turn today's excess discovery
  // transfer into a required contract that blocks a future optimization.
  assert.ok(chat.metrics.full.decodedBodyBytes.min > small.metrics.full.decodedBodyBytes.max + 10000);
  assert.ok(Math.abs(chat.metrics.selected.decodedBodyBytes.max - small.metrics.selected.decodedBodyBytes.max) < 100);
  assert.ok(Math.abs(chat.metrics.search.resultJsonBytes.max - small.metrics.search.resultJsonBytes.max) < 100);
  assert.ok(Math.abs(chat.metrics.search.decodedBodyBytes.max - small.metrics.search.decodedBodyBytes.max) < 100,
    'unrelated messages do not grow current work-only discovery transfer');
  assert.ok(chat.metrics.search.decodedBodyBytes.max < chat.metrics.full.decodedBodyBytes.min);
});

test('discovery profiler refuses unbounded or noninteger fixture sizes before setup', async () => {
  for (const options of [{ workCount: 401, messageCount: 2 }, { workCount: 1, messageCount: 1201 },
    { workCount: 1.5, messageCount: 2 }, { workCount: 1, messageCount: 2, samples: 0 }]) {
    await assert.rejects(profileDiscovery(options), /bounded synthetic/);
  }
  await assert.rejects(profileDiscovery({ workCount: 1, messageCount: 2, managedProducer: 'yes' }), /boolean/);
});

test('discovery profiling separates managed sponsorship reads and immutable projection input from transfer', async () => {
  // Observe counts, but do not make redundant parsing a required contract.
  for (const managedProducer of [false, true]) {
    const profile = await profileDiscovery({ workCount: 4, messageCount: 4, samples: 2, managedProducer });
    assert.equal(profile.credentialMode, managedProducer ? 'owner-connected' : 'legacy-key');
    assert.equal(profile.roomAuditUnchanged, true);
    assert.equal(profile.authorityComparison.equivalent, true);
    assert.ok(profile.authorityComparison.narrowJsonBytes > 0);
    assert.ok(profile.authorityComparison.narrowJsonBytes < profile.projectionJsonBytes);
    for (const timing of Object.values(profile.authorityComparison.millisecondsPerRead)) {
      assert.ok(timing.min >= 0 && timing.min <= timing.median && timing.median <= timing.max);
    }
    for (const metric of Object.values(profile.metrics)) {
      assert.equal(metric.samples, 2);
      assert.ok(Number.isSafeInteger(metric.fullRoomReads.min) && metric.fullRoomReads.min >= 0);
      assert.equal(metric.fullRoomReads.min, metric.fullRoomReads.max);
      assert.equal(metric.fullRoomReads.min, metric.identityFullRoomReads.min + metric.operationFullRoomReads.min);
      assert.equal(metric.fullProjectionInputBytes.min, metric.fullRoomReads.min * profile.projectionJsonBytes);
      assert.equal(metric.fullProjectionInputBytes.min, metric.fullProjectionInputBytes.max);
      assert.equal(metric.authorityReads.min, metric.identityAuthorityReads.min + metric.operationAuthorityReads.min);
      assert.equal(metric.projectionSelections.min, metric.fullRoomReads.min + metric.authorityReads.min);
      assert.equal(metric.javascriptProjectionInputBytes.min,
        metric.fullProjectionInputBytes.min + metric.authorityReads.min * profile.authorityComparison.narrowJsonBytes);
    }
  }
});
