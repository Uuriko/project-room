import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('commons'));
  store.featureEnv = { ROOM_PROJECT_MAP_GRAPHIFY: 'off' };
  const owner = store.issueAccessKey('commons', 'owner'), tokens = { owner }, identities = {};
  for (const [id, permissions, tier] of [['reader', [], 't2_standard'], ['readonly-admin', ['manage_claims'], 't1_readonly'],
    ['manager', ['manage_claims'], 't2_standard'], ['steerer', ['steer'], 't2_standard']]) {
    const identity = store.identities.create(id); identities[id] = identity;
    store.identities.link(owner, 'commons', { identityId: identity.identityId, memberId: id, displayName: id, permissions });
    tokens[id] = store.issueAccessKey('commons', id);
    setTier(store.db, 'commons', id, tier, { updatedBy: 'owner', nowMs: store.now() });
  }
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, body) => fetch(origin + '/api/rooms/commons/map' + path, { method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const revoke = memberId => store.command(owner, 'commons', { id: crypto.randomUUID(), type: 'member.access_changed', data: {
    memberId, expectedMemberRevision: store.room('commons').state.members[memberId].revision, active: true, permissions: [] } });
  return { store, origin, call, tokens, identities, revoke };
}
const source = { repo: 'test/repo', revision: 'a'.repeat(40), files: [{ path: 'a.js', source: 'export function a() {}' }] };
const pull = { repo: 'test/repo', number: 1, files: ['a.js'], state: 'open' };

test('map intake requires live administrative authority and respects read-only autonomy', async t => {
  const f = await fixture(t);
  for (const [path, body] of [['', source], ['/pulls', pull]]) {
    for (const actor of ['reader', 'readonly-admin']) {
      const before = f.store.room('commons').sequence;
      const response = await f.call(path, f.tokens[actor], body);
      assert.equal(response.status, 403, actor);
      assert.equal((await response.json()).error.code, actor === 'readonly-admin' ? 'agent_readonly' : 'access_denied');
      assert.equal(f.store.room('commons').sequence, before);
    }
    for (const actor of ['owner', 'manager', 'steerer']) {
      const response = await f.call(path, f.tokens[actor], body);
      assert.equal(response.status, 200, await response.clone().text());
    }
  }
  for (const actor of ['reader', 'readonly-admin']) assert.equal((await f.call('/query?q=a', f.tokens[actor])).status, 200);
  assert.equal((await f.call('/query?q=a')).status, 401);
  f.revoke('manager');
  assert.equal((await f.call('', f.tokens.manager, source)).status, 403);
});

test('API-key read/write scopes remain independent of map administration', async t => {
  const f = await fixture(t);
  const mint = scopes => `rak_${f.store.agentPlugin.issueApiKey({ identityId: f.identities.manager.identityId, scopes }).secret}`;
  const read = mint(['rooms:read']), write = mint(['rooms:write']);
  assert.equal((await f.call('/query?q=a', read)).status, 200);
  assert.equal((await f.call('', read, source)).status, 403);
  assert.equal((await f.call('/pulls', read, pull)).status, 403);
  assert.equal((await f.call('/query?q=a', write)).status, 403);
  assert.equal((await f.call('', write, source)).status, 200);
  const mcp = async token => {
    const response = await fetch(f.origin + '/room/mcp', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
      jsonrpc: '2.0', id: 'scope', method: 'tools/call', params: { name: 'room_map', arguments: { roomId: 'commons', op: 'hotspots' } } }) });
    return response.json();
  };
  const readResult = await mcp(read);
  assert.equal(readResult.result?.isError, undefined, JSON.stringify(readResult));
  assert.equal(readResult.result?.structuredContent?.revision, source.revision);
  const writeResult = await mcp(write);
  assert.match(JSON.stringify(writeResult), /insufficient_scope/);
  assert.equal(writeResult.result?.structuredContent?.hotspots, undefined);
  f.revoke('manager');
  assert.equal((await f.call('', write, source)).status, 403, 'write scope never replaces current room authority');
});

test('authority revoked while HTTP request body is arriving blocks intake', async t => {
  const f = await fixture(t), token = f.tokens.manager;
  let sawAuthentication;
  const authenticated = new Promise(resolve => { sawAuthentication = resolve; });
  const original = f.store.authenticate.bind(f.store);
  f.store.authenticate = (...args) => { const auth = original(...args); if (args[0] === token) sawAuthentication(); return auth; };
  const encoded = JSON.stringify(source);
  let request;
  const completed = new Promise((resolve, reject) => {
    request = httpRequest(f.origin + '/api/rooms/commons/map', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(text) }));
    });
    request.on('error', reject); request.write(encoded.slice(0, 1));
  });
  await authenticated;
  f.revoke('manager');
  const before = f.store.room('commons').sequence;
  request.end(encoded.slice(1));
  const result = await completed;
  assert.equal(result.status, 403);
  assert.equal(result.value.error.code, 'access_denied');
  assert.equal(f.store.room('commons').sequence, before);
  assert.equal(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_map_queue'").get(), undefined, 'no intake rows created');
});
