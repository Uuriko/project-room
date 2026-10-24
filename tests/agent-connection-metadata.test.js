import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES as T } from '../src/events.js';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readAgentConnection } from '../server/routes/agent-connection.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

const config = { origin: 'https://room.example', roomId: 'commons', memberId: 'agent', token: 'pri_' + 'x'.repeat(43) };
const metadata = () => ({ contractVersion: 1, roomId: 'commons', viewerId: 'agent',
  member: { id: 'agent', kind: 'agent', active: true, revision: 0, permissions: ['accept_work'], delegatedAdmin: false },
  ownerId: 'owner', executionGranted: false });

test('identity preflight uses one compact read for both identity and API credentials', async () => {
  for (const token of ['pri_' + 'x'.repeat(43), 'rak_' + 'x'.repeat(43)]) {
    const paths = [];
    const client = new RoomAgentClient({ ...config, token, fetchImpl: async (url, options) => {
      paths.push(new URL(url).pathname);
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      return Response.json(metadata());
    } });
    const result = await client.checkConnection();
    assert.equal(result.status, 'credential_accepted'); assert.equal(result.externalExecution, false);
    assert.deepEqual(paths, ['/api/rooms/commons/agent-connection']);
  }
});

test('corrupt identity metadata refuses without fallback or subsequent operation', async () => {
  const corruptions = [v => { v.roomId = 'other'; }, v => { v.viewerId = 'other'; },
    v => { v.member.id = 'other'; }, v => { v.member.kind = 'human'; },
    v => { v.member.active = false; }, v => { v.member.revision = 1.5; },
    v => { v.member.permissions = ['invented']; }, v => { v.member.permissions = ['manage_members']; },
    v => { v.contractVersion = 2; }, v => { v.executionGranted = true; },
    v => { v.account = {}; }, v => { delete v.member; }];
  for (const corrupt of corruptions) {
    let calls = 0;
    const client = new RoomAgentClient({ ...config, fetchImpl: async () => {
      calls++; const value = metadata(); corrupt(value); return Response.json(value);
    } });
    await assert.rejects(client.checkConnection(), { code: 'identity_mismatch' });
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(client.claimWorkItem('example'), { code: 'identity_mismatch' });
    assert.equal(calls, 1, 'no write may follow invalid metadata');
  }
});

test('owner and explicit delegated agent authority remain supported', async () => {
  for (const grant of [v => { v.ownerId = 'agent'; }, v => { v.member.delegatedAdmin = true; }]) {
    const value = metadata(); value.member.permissions = ['manage_members', 'decide']; grant(value);
    const client = new RoomAgentClient({ ...config, fetchImpl: async () => Response.json(value) });
    assert.equal((await client.checkConnection()).status, 'credential_accepted');
  }
});

test('only exact route-not-found permits legacy snapshot fallback', async () => {
  for (const [status, code] of [[401, 'unauthenticated'], [403, 'access_denied'], [500, 'internal_error'], [404, 'room_not_found'], [404, 'not_found']]) {
    const paths = [];
    const client = new RoomAgentClient({ ...config, fetchImpl: async url => {
      paths.push(new URL(url).pathname);
      if (url.endsWith('/agent-connection')) return Response.json({ error: { code, message: 'Fixture' } }, { status });
      const value = metadata();
      return Response.json({ roomId: value.roomId, viewerId: value.viewerId,
        state: { members: { agent: value.member }, room: { ownerId: value.ownerId } } });
    } });
    if (status === 404 && code === 'not_found') {
      assert.equal((await client.checkConnection()).status, 'credential_accepted'); assert.equal(paths.length, 2);
    } else { await assert.rejects(client.checkConnection()); assert.equal(paths.length, 1); }
  }
  let calls = 0;
  const client = new RoomAgentClient({ ...config, fetchImpl: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(client.checkConnection(), /offline/); assert.equal(calls, 1);
});

test('real HTTP metadata stays small, enforces scopes, and sees revoked secrets', async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = f.store.identities.create('Connection fixture');
  const ownerKey = f.store.issueAccessKey('commons', 'owner');
  f.store.identities.link(ownerKey, 'commons', { identityId: agent.identityId, permissions: ['accept_work'] });
  const paths = [];
  const client = new RoomAgentClient({ origin, roomId: 'commons', memberId: agent.identityId, token: agent.secret,
    fetchImpl: (url, options) => { paths.push(new URL(url).pathname); return fetch(url, options); } });
  assert.equal((await client.checkConnection()).status, 'credential_accepted');
  assert.deepEqual(paths, ['/api/rooms/commons/agent-connection']);
  const get = (suffix = '', token = agent.secret) => fetch(`${origin}/api/rooms/commons/agent-connection${suffix}`, { headers: { Authorization: `Bearer ${token}` } });
  const value = await (await get()).json();
  assert.deepEqual(Object.keys(value).sort(), ['contractVersion', 'roomId', 'viewerId', 'member', 'ownerId', 'executionGranted'].sort());
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024);
  assert.doesNotMatch(JSON.stringify(value), /messages|events|Connection fixture|secret|token/);
  for (let i = 0; i < 10; i++) f.store.command(ownerKey, 'commons', { id: `metadata-history-${i}`, type: T.MESSAGE_POSTED,
    data: { messageId: `metadata-history-${i}`, body: 'private-history-' + 'x'.repeat(1000) } });
  assert.deepEqual(await (await get()).json(), value, 'room history growth does not grow identity metadata');
  const snapshot = await fetch(`${origin}/api/rooms/commons`, { headers: { Authorization: `Bearer ${agent.secret}` } });
  assert.equal(snapshot.status, 200);
  const snapshotBytes = Buffer.byteLength(await snapshot.text());
  assert.ok(snapshotBytes > Buffer.byteLength(JSON.stringify(value)) * 10);
  t.diagnostic(`fixture bytes: metadata=${Buffer.byteLength(JSON.stringify(value))}, fullSnapshot=${snapshotBytes}`);
  assert.equal((await get('?limit=1')).status, 422);
  assert.equal((await get('', 'pri_invalid')).status, 401);
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${agent.secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const [scopes, expected] of [[['rooms:read'], 200], [['webhooks:manage'], 403]]) {
    const issued = await post('/api/agent-keys', { scopes, label: 'metadata-fixture' });
    assert.equal(issued.status, 201);
    const token = `rak_${(await issued.json()).secret}`;
    assert.equal((await get('', token)).status, expected);
    if (expected === 200) assert.equal((await new RoomAgentClient({ origin, roomId: 'commons', memberId: agent.identityId, token }).checkConnection()).status, 'credential_accepted');
  }
  const member = f.store.room('commons').state.members[agent.identityId];
  f.store.command(ownerKey, 'commons', { id: 'remove-connection-permission', type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: agent.identityId, expectedMemberRevision: member.revision, permissions: [], active: true } });
  assert.deepEqual((await client.checkConnection()).permissions, [], 'permission changes are freshly read');
  const rotated = await post(`/api/agent-identities/${agent.identityId}/rotate`, { confirm: true });
  assert.equal(rotated.status, 200);
  paths.length = 0; await assert.rejects(client.checkConnection()); assert.equal(paths.length, 1);
});

// A future optimization must not accidentally read queues/history or move
// authentication outside the consistent read boundary.
test('metadata authentication and projection share one transaction without queue reads', () => {
  let inside = false, authenticated = false;
  const auth = { credentialScope: 'room', credentialHash: 'fixture', kind: 'identity', member: metadata().member };
  const ctx = { params: { roomId: 'commons' }, req: {}, res: {}, url: new URL('https://example.test/'),
    roomCredentials: () => ({ bearer: true }), expectedBinding: () => null,
    roomAuth: () => { assert.equal(inside, true); authenticated = true; return auth; },
    rate: () => {}, reject: () => { throw Error('Unexpected refusal'); },
    store: { readTransaction(fn) { inside = true; try { return fn(); } finally { inside = false; } },
      room() { assert.equal(inside, true); assert.equal(authenticated, true); return { state: { room: { ownerId: 'owner' } } }; } },
    json: (_res, status, value) => { assert.equal(inside, false); assert.equal(status, 200); return value; } };
  assert.deepEqual(readAgentConnection(ctx), metadata());
});
