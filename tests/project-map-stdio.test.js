import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serveRoomMcp, roomTools } from '../client/mcp-stdio.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { hostedMcpToolDefs } from '../server/mcp-hosted-tools.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { pushProjectMap } from '../server/project-map-store.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('commons'));
  const owner = store.issueAccessKey('commons', 'owner'), identity = store.identities.create('Agent');
  store.identities.link(owner, 'commons', { identityId: identity.identityId, memberId: 'agent', displayName: 'Agent', permissions: [] });
  await pushProjectMap(store, 'commons', { repo: 'test/repo', revision: 'abc', files: [
    { path: 'a.js', source: 'export function helper() { return 1; }' },
    { path: 'b.js', source: 'import { helper } from "./a.js"; export function run() { return helper(); }' }
  ] });
  const http = createRoomServer({ store }); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const requests = []; http.on('request', req => requests.push(req.url));
  const client = new RoomAgentClient({ origin: `http://127.0.0.1:${http.address().port}`, roomId: 'commons', memberId: 'agent', token: identity.secret });
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(); let buffer = '', next = 0;
  const adapter = serveRoomMcp({ client, roomId: 'commons', memberId: 'agent', input, output });
  output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
    const result = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(result.id)?.(result); pending.delete(result.id);
  } });
  const send = value => input.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const rpc = (method, params = {}) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); send({ id, method, params }); });
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  send({ method: 'notifications/initialized' });
  t.after(async () => { adapter.stop(); input.destroy(); output.destroy(); http.closeStreams(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); store.close(); });
  return { store, owner, client, requests, rpc, call: args => rpc('tools/call', { name: 'room_map', arguments: args }) };
}

test('stdio map metadata matches hosted read contract without a room override or duplicate hosted tool', async t => {
  const f = await fixture(t), listed = await f.rpc('tools/list');
  const local = listed.result.tools.find(tool => tool.name === 'room_map');
  const hosted = hostedMcpToolDefs.filter(tool => tool.name === 'room_map');
  assert.equal(hosted.length, 1); assert.equal(roomTools.filter(tool => tool.name === 'room_map').length, 1);
  const { roomId, ...properties } = hosted[0].inputSchema.properties;
  assert.ok(roomId); assert.deepEqual(local.inputSchema.properties, properties);
  assert.deepEqual(local.inputSchema.required, ['op']); assert.equal(local.inputSchema.additionalProperties, false);
  assert.deepEqual(local.annotations, hosted[0].annotations);
});

test('actual stdio calls query, explain, path and hotspots through room-bound HTTP', async t => {
  const f = await fixture(t);
  for (const args of [{ op: 'query', q: 'helper' }, { op: 'explain', q: 'a.js' },
    { op: 'path', from: 'b.js', to: 'a.js' }, { op: 'hotspots' }]) {
    const result = await f.call({ ...args, repo: 'test/repo' });
    assert.equal(result.result?.isError, undefined, JSON.stringify(result));
    assert.equal(result.result.structuredContent.revision, 'abc');
    assert.equal(result.result.structuredContent.repo, 'test/repo');
  }
  assert.equal(f.requests.filter(path => path.startsWith('/api/rooms/commons/map/')).length, 4);
  assert.ok(f.requests.every(path => path.startsWith('/api/rooms/commons')));
});

test('invalid operations and room overrides make no HTTP request; revoked access is refused', async t => {
  const f = await fixture(t);
  for (const args of [{ op: 'query' }, { op: 'hotspots', q: 'a' }, { op: 'path', from: 'a' },
    { op: 'query', q: 'x'.repeat(301) }, { op: 'hotspots', repo: 'x'.repeat(201) },
    { op: 'hotspots', roomId: 'other' }, { op: 'write' }]) {
    assert.equal((await f.call(args)).error.code, -32602);
  }
  assert.equal(f.requests.length, 0);
  assert.throws(() => f.client.projectMap({ op: 'hotspots', roomId: 'other' }));
  f.store.command(f.owner, 'commons', { id: 'remove-agent', type: 'member.access_changed', data: {
    memberId: 'agent', expectedMemberRevision: f.store.room('commons').state.members.agent.revision, active: false, permissions: [] } });
  const denied = await f.call({ op: 'hotspots' });
  assert.equal(denied.result.isError, true); assert.equal(denied.result.structuredContent.revision, undefined);
});
