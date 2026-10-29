import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { linkWithProof } from "./helpers/link-with-proof.mjs";
const config = { origin: 'https://room.example', roomId: 'commons', memberId: 'agent', token: 'pri_' + 'a'.repeat(43) };
const packet = () => ({ snapshotView: 'identity', snapshotVersion: 1, roomId: 'commons', sequence: 0,
  viewerId: 'agent', viewerAccountId: null, viewerAuthEpoch: null, viewerSessionBinding: null, viewerSessionRevision: null,
  state: { room: { ownerId: 'owner' }, members: { agent: { id: 'agent', kind: 'agent', active: true, revision: 0, permissions: [] } }, workItems: {} } });
test('identity and API-key checks request only the versioned identity view, freshly for every operation', async () => {
  for (const prefix of ['pri_', 'rak_']) {
    const paths = [];
    const client = new RoomAgentClient({ ...config, token: prefix + 'a'.repeat(43), fetchImpl: async url => {
      const path = new URL(url).pathname + new URL(url).search; paths.push(path);
      assert.notEqual(path, '/api/rooms/commons', 'full history is never a preflight');
      return Response.json(path.endsWith('?view=identity') ? packet() : { id: 'selected' });
    } });
    await client.checkConnection(); await client.workClaimGet('selected'); await client.workClaimGet('selected');
    assert.deepEqual(paths, ['/api/rooms/commons?view=identity', '/api/rooms/commons?view=identity', '/api/rooms/commons/work-claims/selected', '/api/rooms/commons?view=identity', '/api/rooms/commons/work-claims/selected']);
  }
});
test('projection, principal, account scope, active membership and delegated authority fail closed without fallback', async () => {
  const invalid = [
    p => { delete p.snapshotView; }, p => { p.snapshotVersion = 2; }, p => { p.snapshotView = 'full'; },
    p => { p.roomId = 'other'; }, p => { p.viewerId = 'other'; },
    ...['viewerAccountId','viewerAuthEpoch','viewerSessionBinding','viewerSessionRevision'].map(key => p => { p[key] = 'account'; }),
    p => { p.state.members.agent.id = 'other'; }, p => { p.state.members.agent.revision = -1; },
    p => { p.state.members.agent.active = false; }, p => { p.state.members.agent.kind = 'human'; },
    p => { p.state.members.agent.permissions = ['manage_members']; }, p => { p.state.members.agent.revision = '0'; }
  ];
  for (const mutate of invalid) {
    let calls = 0; const p = packet(); mutate(p);
    const client = new RoomAgentClient({ ...config, fetchImpl: async () => { calls++; return Response.json(p); } });
    await assert.rejects(client.workClaimGet('selected'), { code: 'identity_mismatch' }); assert.equal(calls, 1);
  }
  for (const status of [401,403,404,500]) {
    let calls = 0; const client = new RoomAgentClient({ ...config, fetchImpl: async () => { calls++; return Response.json({ error: { code: 'unavailable' } }, { status }); } });
    await assert.rejects(client.checkConnection(), error => error.status === status); assert.equal(calls, 1);
  }
  for (const owner of [false,true]) {
    const p = packet(); p.state.members.agent.permissions = ['manage_members','decide'];
    if (owner) p.state.room.ownerId = 'agent'; else p.state.members.agent.delegatedAdmin = true;
    assert.equal((await new RoomAgentClient({ ...config, fetchImpl: async () => Response.json(p) }).checkConnection()).memberId, 'agent');
  }
});
test('actual server rechecks identity revocation and API-key scope using bounded identity-view response', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons','owner'), identity = store.identities.create('Fixture agent');
  linkWithProof(store, owner, 'commons', identity, { memberId:'agent',displayName:'Fixture agent',permissions:[]});
  const server = createRoomServer({store}); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, reads = [];
  const fetchImpl = async (url,options) => { const response = await fetch(url,options); const bytes = Buffer.byteLength(await response.clone().text()); reads.push({ path:new URL(url).pathname+new URL(url).search,bytes,status:response.status }); return response; };
  const client = new RoomAgentClient({...config,origin,token:identity.secret,fetchImpl});
  assert.equal((await client.checkConnection()).memberId,'agent'); assert.ok(reads[0].bytes < 5000); assert.ok(reads[0].path.endsWith('?view=identity'));
  const apiKey = 'rak_' + store.agentPlugin.issueApiKey({identityId:identity.identityId,scopes:['rooms:write']}).secret;
  await assert.rejects(new RoomAgentClient({...config,origin,token:apiKey}).checkConnection(), error => error.status === 403);
  store.identities.revoke(identity.identityId,identity.secret);
  await assert.rejects(client.checkConnection(), error => error.status === 401 || error.status === 403);
  assert.equal(reads.length,2); assert.ok(reads.every(row => row.path.endsWith('?view=identity')));
});

test('identity view stays small with large history and never hydrates room or work projections', async t => {
  let clock = Date.now();
  const store = new RoomStore(':memory:', { now: () => clock }); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner'), identity = store.identities.create('Bounded agent');
  linkWithProof(store, owner, 'commons', identity, { memberId: 'agent', displayName: 'Bounded agent', permissions: [] });
  for (let index = 0; index < 80; index++) { clock += 2000; store.command(owner, 'commons', { id: `history-${index}`, type: 'message.posted',
    data: { messageId: `message-${index}`, body: `private-history-${index} ` + 'x'.repeat(4000) } }); }
  const projectionBytes = Buffer.byteLength(store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection);
  assert.ok(projectionBytes > 300000);
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  t.mock.method(store, 'room', () => { throw new Error('identity preflight must not hydrate full room'); });
  const url = `http://127.0.0.1:${server.address().port}/api/rooms/commons?view=identity`;
  const headers = { authorization: `Bearer ${identity.secret}` };
  const response = await fetch(url, { headers }), text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.byteLength(text) < 1200);
  assert.equal(text.includes('private-history'), false);
  const packet = JSON.parse(text);
  assert.deepEqual(Object.keys(packet.state).sort(), ['members', 'room']);
  assert.deepEqual(Object.keys(packet.state.members), ['agent']);
  assert.deepEqual(Object.keys(packet.state.room), ['ownerId']);
  for (const suffix of ['&view=work', '&limit=1', '&auth=invalid']) assert.equal((await fetch(url + suffix, { headers })).status, 422);
  assert.equal((await fetch(url, { headers: { ...headers, 'x-project-room-help-context': '1' } })).status, 422);
  t.diagnostic(`local fixture projection ${projectionBytes} bytes; identity response ${Buffer.byteLength(text)} bytes`);
});


test('older servers receive no fallback and explain server-first upgrade order', async () => {
  let reads = 0;
  const client = new RoomAgentClient({ ...config, fetchImpl: async () => {
    reads++; return Response.json({ error: { code: 'invalid_snapshot_view' } }, { status: 422 });
  } });
  await assert.rejects(client.checkConnection(), error => error.status === 422 && error.code === 'invalid_snapshot_view'
    && /Deploy the matching server/.test(error.message));
  assert.equal(reads, 1);
});
