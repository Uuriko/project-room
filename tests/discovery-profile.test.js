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
});

test('discovery profiler refuses unbounded or noninteger fixture sizes before setup', async () => {
  for (const options of [{ workCount: 401, messageCount: 2 }, { workCount: 1, messageCount: 1201 },
    { workCount: 1.5, messageCount: 2 }, { workCount: 1, messageCount: 2, samples: 0 }]) {
    await assert.rejects(profileDiscovery(options), /bounded synthetic/);
  }
});
