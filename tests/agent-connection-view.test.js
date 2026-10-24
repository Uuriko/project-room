// Owns server/routes/agent-connection.mjs through the real HTTP dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

test('compact connection is bounded, fresh, secret-free and fails closed', async t => {
  const store = new RoomStore(':memory:'), rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen'), worker = store.identities.create('Worker');
  rooms.create(owner.secret, { roomId: 'commons', title: 'Connection', purpose: 'Test', kind: 'personal' });
  store.identities.link(owner.secret, 'commons', { identityId: worker.identityId, displayName: 'Worker', permissions: [] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const read = (token = worker.secret, query = '') => fetch(origin + '/api/rooms/commons/agent-connection' + query,
    { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const before = await (await read()).text();
  for (let i = 0; i < 30; i++) store.command(owner.secret, 'commons', { id: `history-${i}`, type: 'message.posted', data: { messageId: `history-${i}`, body: 'private-sentinel-' + 'x'.repeat(1000) } });
  const sequence = store.room('commons').sequence;
  const listWork = store.replyRequests.list;
  store.replyRequests.list = () => { throw new Error('connection checks must not enumerate work'); };
  const after = await (await read()).text();
  store.replyRequests.list = listWork;
  assert.equal(after, before, 'history growth does not enlarge membership responses');
  assert.ok(Buffer.byteLength(after) < 1024);
  const snapshot = await (await fetch(origin + '/api/rooms/commons', { headers: { authorization: `Bearer ${worker.secret}` } })).text();
  assert.ok(Buffer.byteLength(snapshot) > Buffer.byteLength(after) * 50);
  for (const secret of [owner.secret, worker.secret, 'private-sentinel']) assert.equal(after.includes(secret), false);
  assert.equal(store.room('commons').sequence, sequence);
  assert.equal((await read(null)).status, 401);
  assert.equal((await read(worker.secret, '?extra=1')).status, 422);
  const key = store.agentPlugin.issueApiKey({ identityId: worker.identityId, scopes: ['rooms:read'] });
  assert.equal((await read(`rak_${key.secret}`)).status, 200);
  const writeKey = store.agentPlugin.issueApiKey({ identityId: worker.identityId, scopes: ['rooms:write'] });
  assert.equal((await read(`rak_${writeKey.secret}`)).status, 403);
  let mode = null; const paths = [];
  const client = new RoomAgentClient({ origin, roomId: 'commons', memberId: worker.identityId, token: worker.secret,
    fetchImpl: async (url, options) => {
      paths.push(new URL(url).pathname);
      if (!url.endsWith('/agent-connection') || mode === null) return fetch(url, options);
      if (typeof mode === 'number') return Response.json({ error: { code: mode === 404 ? 'not_found' : 'access_denied', message: 'Fixture' } }, { status: mode });
      const value = JSON.parse(after); mode(value); return Response.json(value);
    } });
  assert.equal((await client.checkConnection()).status, 'credential_accepted');
  assert.deepEqual(paths, ['/api/rooms/commons/agent-connection']);
  for (const corrupt of [v => { v.viewerId = owner.identityId; }, v => { v.member.active = false; },
    v => { v.member.id = owner.identityId; }, v => { v.executionGranted = true; },
    v => { v.member.revision = -1; }, v => { v.member.permissions = ['decide']; },
    v => { v.member.permissions = ['read', 'read']; }, v => { v.contractVersion = 2; }]) {
    mode = corrupt; paths.length = 0; await assert.rejects(client.checkConnection()); assert.equal(paths.length, 1);
  }
  for (const status of [401, 403, 429, 500]) {
    mode = status; paths.length = 0; await assert.rejects(client.checkConnection()); assert.equal(paths.length, 1);
  }
  mode = 404; paths.length = 0;
  assert.equal((await client.checkConnection()).status, 'credential_accepted');
  assert.deepEqual(paths, ['/api/rooms/commons/agent-connection', '/api/rooms/commons']);
  mode = null;
  store.identities.unlink(owner.secret, 'commons', worker.identityId);
  paths.length = 0; await assert.rejects(client.checkConnection()); assert.equal(paths.length, 1, 'revocation never falls back');
  const ownerClient = new RoomAgentClient({ origin, roomId: 'commons', memberId: owner.identityId, token: owner.secret });
  assert.equal((await ownerClient.checkConnection()).status, 'credential_accepted');
  t.diagnostic(`membership response ${Buffer.byteLength(after)} bytes; full snapshot ${Buffer.byteLength(snapshot)} bytes`);
});
