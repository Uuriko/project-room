// Real HTTP headers remain authoritative when an intermediary's error body fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { isTransientWakeError, wakeRetryDelayMs } from '../client/wake-retry.mjs';

async function fixture(t, status, mode) {
  let failed = false;
  const healthy = { agentId: 'agent', status: 'offline', hosts: [] };
  const server = createServer((req, res) => {
    if (req.url === '/api/rooms/test-room?view=identity') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ snapshotView: 'identity', snapshotVersion: 1,
        roomId: 'test-room', viewerId: 'agent', viewerAccountId: null, viewerAuthEpoch: null,
        viewerSessionBinding: null, viewerSessionRevision: null,
        state: { members: { agent: { id: 'agent', kind: 'agent', active: true, revision: 1, permissions: [] } } } }));
    }
    assert.equal(req.url, '/api/agent-heartbeats');
    if (failed) return res.end(JSON.stringify(healthy));
    failed = true;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '120' });
    if (mode === 'interrupted') {
      res.write('{"incomplete":');
      const timer = setTimeout(() => res.destroy(), 20);
      res.on('close', () => clearTimeout(timer));
    } else if (mode === 'oversized') res.end('x'.repeat(262145));
    else if (mode === 'boundary') res.end(JSON.stringify(healthy).padEnd(262144, ' '));
    else if (mode === 'malformed') res.end('not json');
    else res.end(JSON.stringify({ error: { code: 'upstream_failure' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return new AgentWakeClient({ connection: { origin: `http://127.0.0.1:${server.address().port}`,
    roomId: 'test-room', memberId: 'agent', token: 'pri_' + 's'.repeat(43) } });
}
for (const status of [401, 403, 429, 503]) for (const mode of ['complete', 'oversized', 'interrupted']) {
  test(`HTTP ${status} ${mode} error body preserves status and retry timing`, async t => {
    const client = await fixture(t, status, mode);
    await assert.rejects(client.doctor({ hostId: 'test-host' }), error => {
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 120000);
      assert.equal(isTransientWakeError(error), status === 429 || status === 503);
      assert.equal(wakeRetryDelayMs(0, error), 120000);
      assert.equal(error.message.includes('pri_'), false);
      return true;
    });
    // A bad response must not poison the next explicit observation.
    assert.equal((await client.doctor({ hostId: 'test-host' })).registration, 'not_registered');
  });
}
for (const mode of ['oversized', 'malformed', 'interrupted']) {
  test(`HTTP 200 ${mode} body remains rejected`, async t => {
    const client = await fixture(t, 200, mode);
    await assert.rejects(client.doctor({ hostId: 'test-host' }), error => {
      assert.equal(error.status, mode === 'interrupted' ? 0 : 200);
      assert.equal(error.code, mode === 'interrupted' ? 'service_unavailable' : 'invalid_response');
      return true;
    });
  });
}
test('HTTP 200 body at the exact size boundary remains valid', async t => {
  const client = await fixture(t, 200, 'boundary');
  assert.equal((await client.doctor({ hostId: 'test-host' })).registration, 'not_registered');
});
