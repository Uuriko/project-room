import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

// Real HTTP contract plus transport corruption: a bad combined read must not
// become execution input or silently downgrade to weaker legacy validation.
test('agent work pickup is one authenticated read and only missing routes fall back', async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const paths = []; let mode = null;
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons',
    memberId: 'producer', token: f.keys.producer, fetchImpl: async (url, options) => {
      paths.push(new URL(url).pathname);
      if (!url.endsWith('/agent-work') || !mode) return fetch(url, options);
      if (typeof mode === 'number') return Response.json({ error: { code: mode === 404 ? 'not_found' : 'access_denied', message: 'Fixture' } }, { status: mode });
      const response = await fetch(url, options), value = await response.json(); mode(value); return Response.json(value);
    } });
  const value = await client.agentWork();
  assert.deepEqual(value.requests, []); assert.deepEqual(value.runs, {});
  assert.deepEqual(paths, ['/api/rooms/commons/agent-work']);
  for (const corrupt of [v => { v.viewerId = 'owner'; }, v => { v.member.kind = 'human'; },
    v => { v.member.active = false; }, v => { v.executionGranted = true; },
    v => { v.blockedBy = []; }, v => { v.blockedBy = null; },
    v => { v.blockedBy = { foreign: ['paused'] }; },
    v => { v.requests = [{ id: 'q', recipientId: 'producer', status: 'open', revision: 0 }]; v.blockedBy = { q: 'paused' }; },
    v => { v.requests = [{ id: 'q', recipientId: 'producer', status: 'open', revision: 0 }]; v.blockedBy = { q: [] }; },
    v => { v.requests = [{ id: 'q', recipientId: 'producer', status: 'open', revision: 0 }]; v.blockedBy = { q: ['paused', 'paused'] }; },
    v => { v.runs = 7; }, v => { v.evaluatedThrough = -1; }, v => { v.runs = { foreign: { state: 'working', updatedAt: 1 } }; },
    v => { v.requests = [{ id: 'foreign', recipientId: 'owner', status: 'open', revision: 0 }]; }]) {
    mode = corrupt; paths.length = 0;
    await assert.rejects(client.agentWork(), /invalid|identity|configured/i);
    assert.equal(paths.length, 1, 'invalid observations must not fall back');
  }
  for (const status of [401, 403, 500]) {
    mode = status; paths.length = 0; await assert.rejects(client.agentWork()); assert.equal(paths.length, 1);
  }
  mode = v => { delete v.blockedBy; };
  assert.deepEqual((await client.agentWork()).requests, [], 'older observation without blockers remains supported');
  mode = v => { v.requests = [{ id: 'q', recipientId: 'producer', status: 'open', revision: 0 }]; v.blockedBy = { q: ['future_standing_reason'] }; };
  assert.deepEqual((await client.agentWork()).blockedBy, { q: ['future_standing_reason'] });
  mode = 404; paths.length = 0;
  assert.deepEqual((await client.agentWork()).requests, []);
  assert.ok(paths.some(path => path.endsWith('/reply-requests')));
  assert.equal(paths.some(path => path.endsWith('/request-runs')), false);
});
