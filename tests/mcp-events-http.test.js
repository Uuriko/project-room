// Exercises server/mcp-events-runtime.mjs through the real authenticated HTTP mount and committed Room events.
import { writeTalkPolicy } from '../server/agent-talk-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createMcpInviteOAuth } from '../server/mcp-invite-oauth.mjs';
const version = '2026-07-28', origin = 'https://room.example', resource = origin + '/mcp';
const client = { clientId: 'events-test', name: 'Events test', redirectUris: ['https://client.example/callback'] };
async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const invite = store.invites.create(owner, 'commons', { profile: 'member' });
  const native = createMcpInviteOAuth({ store, clients: [client], resource });
  const verifier = 'a'.repeat(43);
  const { nonce } = native.begin(new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read chat:read chat:write work:read work:write', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource }));
  const code = new URL(native.approve(nonce, invite.code, 'Friend Dot')).searchParams.get('code');
  const tokens = native.provider.exchangeCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier, resource });
  const grant = store.db.prepare('SELECT * FROM oauth_invite_grants').get();
  const deliveries = [];
  const server = createRoomServer({ store, origin, mcpOAuthClients: [client],
    mcpEventDnsResolvers: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] },
    mcpEventTransport: async (url, addresses, req) => {
      const body = JSON.parse(req.body);
      if (body.type === 'verification') return { status: 200, text: async () => JSON.stringify({ challenge: body.challenge }) };
      deliveries.push(req); return { status: 200, text: async () => '{}' };
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const rpc = (method, params = {}, token = tokens.accessToken) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      Host: 'room.example', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
      'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(params.name && method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
    } }, res => { let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, ...JSON.parse(body) })); });
    req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } }));
  });
  const subscribe = changes => rpc('events/subscribe', { name: 'room.requested', arguments: { roomId: 'commons', memberId: grant.member_id }, delivery: { mode: 'webhook', url: 'https://callback.example/events', secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64') }, ...changes });
  const mention = id => store.command(owner, 'commons', { id, type: 'message.posted', data: { messageId: id, body: 'Please report back.', toMemberId: grant.member_id } });
  return { store, owner, server, native, tokens, grant, deliveries, rpc, subscribe, mention, base: `http://127.0.0.1:${server.address().port}` };
}
test('authenticated modern Events subscribe -> atomic permitted wake -> signed callback -> revoke', async t => {
  const f = await fixture(t);
  const discovery = await f.rpc('server/discover'); assert.equal(discovery.status, 200); assert.deepEqual(discovery.result.capabilities.events, {});
  assert.equal(discovery.headers['mcp-protocol-version'], version);
  const list = await f.rpc('events/list'); assert.equal(list.result.events[0].name, 'room.requested');
  assert.equal((await f.subscribe({ arguments: { roomId: 'commons', memberId: 'owner' } })).error.code, -32602);
  const sub = await f.subscribe({ ttlMs: 60000 }); assert.ok(sub.result?.id, JSON.stringify(sub));
  assert.ok(Date.parse(sub.result.refreshBefore) <= Date.now() + 60000);
  f.mention('native-request');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox').get().n, 1);
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  const event = JSON.parse(f.deliveries[0].body); assert.deepEqual(event.data, { roomId: 'commons', memberId: f.grant.member_id, messageId: 'native-request' });
  assert.ok(f.deliveries[0].headers['webhook-signature']);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM mcp_event_subscriptions').all()).includes(f.tokens.accessToken));
  assert.throws(() => f.store.transaction(() => { f.mention('rolled-back'); throw new Error('rollback'); }), /rollback/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox').get().n, 1);
  f.mention('after-revoke'); f.native.provider.revoke(f.tokens.refreshToken);
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  assert.equal((await f.rpc('events/list')).status, 401);
});
test('native work assignment needs no desktop host registration and unsubscribe stops delivery', async t => {
  const f = await fixture(t); const sub = await f.subscribe(); assert.ok(sub.result.id);
  assert.equal(f.store.agentHeartbeats.statusOf(f.grant.identity_id).hosts.length, 0);
  f.store.command(f.owner, 'commons', { id: 'native-assign', type: 'work.proposed', data: { workItemId: 'native-task', title: 'Review the plan', definitionOfDone: 'A concrete review', accountableMemberId: f.grant.member_id, mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false } });
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  assert.equal((await f.rpc('events/unsubscribe', { name: 'room.requested', arguments: { memberId: f.grant.member_id, roomId: 'commons' }, delivery: { mode: 'webhook', url: 'https://callback.example/events' } })).result.resultType, 'complete');
  f.mention('after-unsubscribe'); await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
});

test('official pinned modern client uses invitation OAuth for attributed Room tools', { skip: !process.env.ROOM_MCP_REFERENCE_CLIENT }, async t => {
  const f = await fixture(t);
  const { Client, StreamableHTTPClientTransport } = await import(process.env.ROOM_MCP_REFERENCE_CLIENT);
  const nativeClient = new Client({ name: 'Official native test', version: '2.4.0' }, { versionNegotiation: { mode: { pin: version } } });
  const fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const req = request(f.base + new URL(url).pathname, { method: init.method || 'GET', headers: { ...Object.fromEntries(new Headers(init.headers)), Host: 'room.example' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }); req.on('error', reject); req.end(init.body);
  });
  await nativeClient.connect(new StreamableHTTPClientTransport(new URL(resource), { fetch, requestInit: { headers: { Authorization: 'Bearer ' + f.tokens.accessToken } } }));
  t.after(() => nativeClient.close());
  const tools = await nativeClient.listTools(); assert.ok(tools.tools.some(x => x.name === 'room_post_message'));
  const posted = await nativeClient.callTool({ name: 'room_post_message', arguments: { id: 'sdk-native-post', body: 'Native SDK connected as my own agent.' } });
  assert.notEqual(posted.isError, true, JSON.stringify(posted));
  assert.equal(f.store.room('commons').state.messages.at(-1).authorId, f.grant.member_id);
});

test('queued native wake rechecks talk policy; private policy metadata never reaches webhook', async t => {
  const f = await fixture(t); await f.subscribe(); f.mention('policy-before-delivery');
  const row = f.store.db.prepare('SELECT document FROM mcp_event_outbox').get();
  assert.equal(JSON.parse(row.document)._roomPolicy.actorId, 'owner');
  writeTalkPolicy(f.store.db, f.store.room('commons').state, { roomId: 'commons', actorId: 'owner', memberId: f.grant.member_id, policy: 'nobody' }, Date.now(), (...args) => { throw new Error(args.join(' ')); });
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 0);
  writeTalkPolicy(f.store.db, f.store.room('commons').state, { roomId: 'commons', actorId: 'owner', memberId: f.grant.member_id, policy: 'room' }, Date.now(), (...args) => { throw new Error(args.join(' ')); });
  f.mention('policy-restored'); await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  assert.ok(!f.deliveries[0].body.includes('_roomPolicy')); assert.ok(!f.deliveries[0].body.includes('actorId'));
});
test('pause blocks pending native deliveries but never prevents unsubscribe', async t => {
  const f = await fixture(t); const sub = await f.subscribe(); f.mention('before-pause');
  f.store.wakeQueue.pause(f.owner, 'commons', { requestId: 'pause-native-agent', reason: 'Stop for now' }, null, { memberId: f.grant.member_id });
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 0);
  assert.equal((await f.rpc('events/unsubscribe', { id: sub.result.id })).result.resultType, 'complete');
  assert.equal(f.store.db.prepare('SELECT state FROM mcp_event_subscriptions').get().state, 'inactive');
});
