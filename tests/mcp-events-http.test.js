import { enqueueClaimWake, wakeNamedReviewers } from "../server/work-claim-events.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { wakeAccounting } from "../server/wake-metrics.mjs";
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
async function fixture(t, { callbackError } = {}) {
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
      if (body.type === 'verification' && callbackError) throw callbackError;
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
  for (const name of ['room_read_work', 'room_claim', 'room_submit_text_result']) assert.ok(tools.tools.some(x => x.name === name), name);
  assert.ok(!tools.tools.some(x => x.name === 'room_create_agent_invite'));
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

test('saturated native callback retains bounded backlog without rolling back useful work', async t => {
  const f = await fixture(t); const sub = await f.subscribe(); assert.ok(sub.result.id);
  const insert = f.store.db.prepare("INSERT INTO mcp_event_outbox(subscription_id,event_id,document,next_at) VALUES(?,?,?,?)");
  for (let i = 0; i < 1000; i++) insert.run(sub.result.id, 'stalled_' + i, '{}', Date.now() + 600000);
  const command = { id: 'capacity-assignment', type: 'work.proposed', data: {
    workItemId: 'capacity-task', title: 'Useful task', definitionOfDone: 'Concrete result',
    accountableMemberId: f.grant.member_id, mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false,
  } };
  f.store.command(f.owner, 'commons', command);
  assert.equal(f.store.room('commons').state.workItems['capacity-task'].title, 'Useful task');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox').get().n, 1000);
  const accounting = wakeAccounting(f.store.db, { roomId: 'commons', now: Date.now() });
  assert.equal(accounting.failures.byReason.native_callback_capacity, 1);
  assert.equal(accounting.byStore.queue.doorbell_failed, 1);
  assert.equal(accounting.byStore.queue.doorbell_delivered, 0);
  // Retrying the committed work does not create another loss or duplicate task.
  f.store.command(f.owner, 'commons', command);
  assert.equal(wakeAccounting(f.store.db, { roomId: 'commons' }).failures.byReason.native_callback_capacity, 1);
  // Another healthy callback for the same agent remains independently usable.
  const healthy = await f.subscribe({ delivery: { mode: 'webhook', url: 'https://callback.example/healthy', secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64') } });
  assert.ok(healthy.result.id);
  f.mention('capacity-message');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox WHERE subscription_id=?').get(sub.result.id).n, 1000);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox WHERE subscription_id=?').get(healthy.result.id).n, 1);
  await f.server.drainMcpEvents();
  assert.equal(f.deliveries.length, 1);
  assert.equal(JSON.parse(f.deliveries[0].body).data.messageId, 'capacity-message');
});

test('authenticated subscription rejection logs only code and canonical blocked origin', async t => {
  const secretPath = '/private-callback-token', secretQuery = 'signing=private-query-token';
  const f = await fixture(t, { callbackError: Object.assign(new Error('private-error-message'), {
    code: -32015, data: { reason: 'callback_origin_not_allowed', origin: 'https://callback.example' + secretPath + '?' + secretQuery },
  }) });
  const warnings = []; t.mock.method(console, 'warn', value => warnings.push(value));
  const response = await f.subscribe({ delivery: { mode: 'webhook', url: 'https://callback.example' + secretPath + '?' + secretQuery,
    secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64') } });
  assert.equal(response.error.code, -32015);
  assert.deepEqual(warnings.map(value => JSON.parse(value)), [{ event: 'room.mcp_event_subscription_rejected', code: -32015,
    reason: 'callback_origin_not_allowed', origin: 'https://callback.example' }]);
  for (const privateValue of [secretPath, secretQuery, 'private-error-message', f.tokens.accessToken, f.grant.member_id,
    'whsec_' + Buffer.alloc(32, 9).toString('base64')]) assert.equal(warnings.join('').includes(privateValue), false);
  warnings.length = 0;
  assert.equal((await f.rpc('events/subscribe', {}, 'iat_invalid')).status, 401);
  assert.deepEqual(warnings, []);
  const malformed = await f.subscribe({ ttlMs: 'private-invalid-ttl' });
  assert.ok(malformed.error);
  assert.deepEqual(warnings.map(value => JSON.parse(value)), [{ event: 'room.mcp_event_subscription_rejected', code: -32602 }]);
});

test('subscription rejection survives an unavailable diagnostic sink', async t => {
  const f = await fixture(t, { callbackError: Object.assign(new Error('callback blocked'), {
    code: -32015, data: { reason: 'callback_origin_not_allowed', origin: 'https://callback.example' },
  }) });
  t.mock.method(console, 'warn', () => { throw new Error('log sink unavailable'); });
  assert.equal((await f.subscribe()).error.code, -32015);
  assert.equal((await f.subscribe({ ttlMs: 'invalid' })).error.code, -32602);
});

test('legacy initialize advertises Events only for authenticated OAuth with a mounted runtime', async t => {
  const f = await fixture(t);
  const initialization = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-events', version: '1' },
  } };
  const legacy = (message, token) => new Promise((resolve, reject) => {
    const req = request(f.base + '/mcp', { method: 'POST', headers: { Host: 'room.example', 'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25', ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
    }); req.on('error', reject); req.end(JSON.stringify(message));
  });
  const initialized = await legacy(initialization, f.tokens.accessToken);
  assert.deepEqual(initialized.result.capabilities, { tools: {}, events: {} });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal((await legacy({ jsonrpc: '2.0', id: 2, method: 'events/list', params: {} }, f.tokens.accessToken)).result.events[0].name, 'room.requested');
  assert.deepEqual((await legacy(initialization)).result.capabilities, { tools: {} });
  const disabled = createHostedRoomMcp(f.store, { inviteOAuthProvider: f.native.provider, oauthResource: resource });
  assert.deepEqual((await disabled(initialization, { authorization: 'Bearer ' + f.tokens.accessToken })).result.capabilities, { tools: {} });
  f.native.provider.revoke(f.tokens.refreshToken);
  assert.ok((await legacy(initialization, f.tokens.accessToken)).error);
});

test('Board assignments use native subscription without desktop opt-in and fence stale owner or revoked grant', async t => {
  const f = await fixture(t); await f.subscribe();
  const board = (path, data) => new Promise((resolve, reject) => {
    const req = request(f.base + '/api/rooms/commons/work-claims' + path, { method: 'POST', headers: {
      Host: 'room.example', 'Content-Type': 'application/json', Authorization: 'Bearer ' + f.owner,
    } }, res => { let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject); req.end(JSON.stringify(data));
  });
  assert.equal(f.store.agentHeartbeats.statusOf(f.grant.identity_id).hosts.length, 0);
  const created = await board('', { id: 'native-board', title: 'Review this small task', assignee: f.grant.member_id });
  assert.equal(created.status, 201, created.body);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox').get().n, 1);
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  assert.deepEqual(JSON.parse(f.deliveries[0].body).data, { roomId: 'commons', memberId: f.grant.member_id });
  assert.ok(!f.deliveries[0].body.includes('claimBasis'));
  const assigned = await board('', { id: 'stale-board', title: 'Old assignment', assignee: f.grant.member_id });
  assert.equal(assigned.status, 201, assigned.body);
  const item = f.store.workClaims.get('commons', 'stale-board');
  f.store.workClaims.set('commons', { ...item, owner: 'owner' });
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  const owned = await board('', { id: 'reassigned-board', title: 'Reassign to native agent', assignee: 'owner' });
  assert.equal(owned.status, 201, owned.body);
  const prior = f.store.workClaims.get('commons', 'reassigned-board');
  const moved = await board('/reassigned-board/reassign', { newOwner: f.grant.member_id,
    expectedClaimedAt: prior.claimedAt, expectedHistoryLength: prior.history.length });
  assert.equal(moved.status, 200, moved.body);
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 2);
  const read = await f.rpc('tools/call', { name: 'room_read_board', arguments: {} });
  assert.notEqual(read.result?.isError, true, JSON.stringify(read));
  assert.ok(JSON.stringify(read).includes('reassigned-board'));
  const inbox = await f.rpc('tools/call', { name: 'room_read_inbox', arguments: {} });
  assert.ok(JSON.stringify(inbox).includes('reassigned-board'), 'inbox exposes own standing Board assignment');
  assert.ok(!JSON.stringify(inbox).includes('stale-board'), 'another owner assignment is excluded');
  const catalog = await f.rpc('tools/list');
  assert.ok(!catalog.result.tools.some(tool => tool.name === 'room_reassign_work_claim'), 'do not widen native Board mutation capabilities');
  const revoked = await board('', { id: 'revoked-board', title: 'Revoked assignment', assignee: f.grant.member_id });
  assert.equal(revoked.status, 201, revoked.body);
  f.native.provider.revoke(f.tokens.refreshToken);
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 2);
});


test('native Board review wakes deduplicate and reject changed revision and missing permission', async t => {
  const f = await fixture(t); await f.subscribe();
  const { createWork, claimWork } = await import('../server/work-claims.mjs');
  let item = claimWork(createWork({ id: 'native-review', title: 'Review this', tags: ['rev-' + f.grant.member_id] },
    { agentId: 'owner', now: Date.now() }), 'owner', { now: Date.now() });
  item = { ...item, state: 'in_progress', revision: 'one' };
  f.store.workClaims.set('commons', item);
  const member = f.store.room('commons').state.members[f.grant.member_id];
  // The fixture's Member grant already carries reviewer authority, or this wake must be refused.
  const canReview = member.permissions.includes('verify');
  assert.equal(canReview, true, 'fixture must exercise actual reviewer delivery');
  wakeNamedReviewers(f.store, 'commons', item, { actorId: 'owner' });
  wakeNamedReviewers(f.store, 'commons', item, { actorId: 'owner' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM mcp_event_outbox').get().n, canReview ? 1 : 0);
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  const inbox = await f.rpc('tools/call', { name: 'room_read_inbox', arguments: {} });
  assert.deepEqual(inbox.result.structuredContent.boardReviewRequests, [{ claimId: 'native-review', state: 'in_progress',
    nextRead: { tool: 'room_read_board', arguments: { roomId: 'commons' } } }]);
  assert.deepEqual(inbox.result.structuredContent.boardAssignments, []);
  item = { ...item, revision: 'two' }; f.store.workClaims.set('commons', item);
  wakeNamedReviewers(f.store, 'commons', item, { actorId: 'owner' });
  f.store.workClaims.set('commons', { ...item, revision: 'three' });
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
  enqueueClaimWake(f.store, 'commons', f.grant.member_id, 'work-claim:native-review:review:three', { actorId: 'owner' });
  f.store.command(f.owner, 'commons', { id: 'remove-review-permission', type: 'member.access_changed',
    data: { memberId: member.id, expectedMemberRevision: member.revision, active: true,
      permissions: member.permissions.filter(permission => permission !== 'verify') } });
  await f.server.drainMcpEvents(); assert.equal(f.deliveries.length, 1);
});
