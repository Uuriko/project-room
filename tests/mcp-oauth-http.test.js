import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { mcpOAuthIdentityEpoch } from '../server/mcp-oauth.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { request } from 'node:http';
const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const req = request(url, { method: options.method || 'GET', headers: { Host: 'room.example', ...options.headers } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject);
  req.end(options.body?.toString());
});
const CLIENT = { clientId: 'test-dot', name: 'Test Native Agent', redirectUris: ['https://client.example/callback'] };
const origin = 'https://room.example';
const resource = origin + '/mcp';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
async function setup(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const ownerSession = store.createSession(ownerKey);
  const accountId = store.db.prepare("SELECT account_id FROM member_accounts WHERE member_id='owner'").get().account_id;
  const accountKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accountKey, 0);
  const identity = store.identities.create('Friend Dot');
  const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
  store.agentConnections.apply(ownerSession.token, 'commons', { action: 'create', requestId: randomUUID(), memberId: 'friend-dot', displayName: 'Friend Dot', access: 'collaborate',
    expectedOwnerRevision: 0, expiresAt: store.now() + 3600000, keyHash: createHash('sha256').update(randomUUID()).digest('hex'), identityId: identity.identityId, identityLinkCode: linkCode }, ownerSession.session.sessionBinding);
  setTier(store.db, 'commons', 'friend-dot', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const binding = { resource, roomId: 'commons', memberId: 'friend-dot', identityId: identity.identityId, humanMemberId: 'owner', identityEpoch: mcpOAuthIdentityEpoch(store, identity.identityId) };
  const server = createRoomServer({ store, origin, mcpOAuthClients: [CLIENT] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const consent = (changes = {}) => fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: `__Host-account_session=${slot.token}`, Origin: origin, 'X-CSRF-Token': session.csrf },
    body: JSON.stringify({ decision: 'allow', client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], scope: 'rooms:read chat:read chat:write work:read work:write',
      code_challenge: challenge, code_challenge_method: 'S256', resource, agent_binding: JSON.stringify(binding), ...changes }) });
  const exchange = body => fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const authorized = await consent();
  assert.equal(authorized.status, 302, await authorized.text());
  const code = new URL(authorized.headers.get('location')).searchParams.get('code');
  assert.ok(code, authorized.headers.get('location'));
  const exchanged = await exchange({ grant_type: 'authorization_code', code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: verifier, resource });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  const rpc = async (method, params = {}, token = tokens.access_token) => {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }) });
    return { response, body: await response.json() };
  };
  return { store, ownerKey, identity, binding, base, consent, exchange, tokens, rpc, cookie: `__Host-account_session=${slot.token}` };
}
test('native OAuth connects an agent, reads and posts as that agent, never authenticates REST', async t => {
  const f = await setup(t);
  const authorizeUrl = f.base + '/oauth/authorize?' + new URLSearchParams({ client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], connection: 'account', scope: 'rooms:read', state: 'screen', code_challenge: challenge, code_challenge_method: 'S256', resource });
  const screen = await fetch(authorizeUrl, { headers: { Cookie: f.cookie } });
  assert.equal(screen.status, 200);
  assert.match(await screen.text(), /name="agent_binding"/);
  const metadata = await fetch(f.base + '/.well-known/oauth-protected-resource/mcp');
  assert.equal((await metadata.json()).resource, resource);
  const noAuth = await f.rpc('tools/call', { name: 'room_check_access', arguments: {} }, null);
  assert.equal(noAuth.response.status, 401);
  assert.match(noAuth.response.headers.get('www-authenticate'), /resource_metadata=/);
  const access = await f.rpc('tools/call', { name: 'room_check_access', arguments: {} });
  assert.equal(access.body.result?.structuredContent.memberId, 'friend-dot', JSON.stringify(access.body));
  const posted = await f.rpc('tools/call', { name: 'room_post_message', arguments: { body: 'Hello from my existing agent', id: 'oauth-hello' } });
  assert.notEqual(posted.body.result?.isError, true, JSON.stringify(posted.body));
  assert.equal(posted.body.error, undefined);
  const messages = await f.rpc('tools/call', { name: 'room_read_messages', arguments: { limit: 10 } });
  assert.match(JSON.stringify(messages.body), /Hello from my existing agent/);
  assert.match(JSON.stringify(messages.body), /friend-dot/);
  assert.throws(() => f.store.authenticate(f.tokens.access_token, 'commons'), /outside its resource/);
  const rest = await fetch(f.base + '/api/rooms/commons', { headers: { Authorization: 'Bearer ' + f.tokens.access_token } });
  assert.notEqual(rest.status, 200);
  for (const name of ['room_create', 'room_identity_mint', 'room_run_action', 'room_create_agent_invite', 'webhook_subscribe']) {
    const denied = await f.rpc('tools/call', { name, arguments: {} });
    assert.ok(denied.body.error || denied.body.result?.isError, name);
  }
  const other = await f.rpc('tools/call', { name: 'room_read_messages', arguments: { roomId: 'elsewhere' } });
  assert.ok(other.body.error || other.body.result?.isError);
  const listed = await f.rpc('tools/list');
  assert.equal(listed.body.result.profile, 'full');
  for (const name of ['room_read_work', 'room_claim', 'room_submit_text_result']) assert.ok(listed.body.result.tools.some(tool => tool.name === name), name);
  assert.ok(listed.body.result.tools.length > 0);
  assert.ok(!listed.body.result.tools.some(tool => tool.name === 'room_create_agent_invite'));
});
test('consent refuses other owners, wrong audiences and forged choices', async t => {
  const f = await setup(t);
  for (const changes of [{ resource: 'https://evil.example/mcp' }, { agent_binding: JSON.stringify({ ...f.binding, humanMemberId: 'stranger' }) }, { agent_binding: '{}' }]) {
    const response = await f.consent(changes);
    assert.equal(response.status, 302);
    assert.ok(new URL(response.headers.get('location')).searchParams.has('error'));
  }
  const wrongRefresh = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource: 'https://evil.example/mcp' });
  assert.equal(wrongRefresh.status, 400);
  const validRefresh = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource });
  assert.equal(validRefresh.status, 200);
});
test('removing sponsored membership rejects existing access and refresh tokens', async t => {
  const f = await setup(t);
  const member = f.store.room('commons').state.members['friend-dot'];
  f.store.command(f.ownerKey, 'commons', { id: randomUUID(), type: 'member.access_changed', data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions } });
  const denied = await f.rpc('tools/call', { name: 'room_check_access', arguments: {} });
  assert.equal(denied.response.status, 401);
  const refresh = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource });
  assert.equal(refresh.status, 400);
});
test('read-only grant cannot call chat writes or wrapper tools and revoked grant stops immediately', async t => {
  const f = await setup(t);
  const authorized = await f.consent({ scope: 'rooms:read chat:read' });
  const code = new URL(authorized.headers.get('location')).searchParams.get('code');
  const response = await f.exchange({ grant_type: 'authorization_code', code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: verifier, resource });
  const tokens = await response.json();
  const listed = await f.rpc('tools/list', {}, tokens.access_token);
  assert.ok(listed.body.result.tools.every(tool => !['room_post_message', 'room_claim', 'room_run_action'].includes(tool.name)));
  const denied = await f.rpc('tools/call', { name: 'room_post_message', arguments: { body: 'should not post' } }, tokens.access_token);
  assert.ok(denied.body.error || denied.body.result?.isError);
  const revoked = await fetch(f.base + '/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tokens.refresh_token }) });
  assert.equal(revoked.status, 200);
  assert.equal((await f.rpc('tools/list', {}, tokens.access_token)).response.status, 401);
});
test('an OAuth agent accepts, starts and submits a concrete read-task result', async t => {
  const f = await setup(t);
  f.store.command(f.ownerKey, 'commons', { id: 'assign-dot', type: 'work.proposed', data: { workItemId: 'dot-task', title: 'Explain the first useful step', definitionOfDone: 'One concrete next step with a reason', accountableMemberId: 'friend-dot', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false } });
  for (const name of ['room_accept_work', 'room_start_work']) {
    const reply = await f.rpc('tools/call', { name, arguments: { workItemId: 'dot-task' } });
    assert.equal(reply.body.error, undefined, JSON.stringify(reply.body));
    assert.notEqual(reply.body.result?.isError, true, JSON.stringify(reply.body));
  }
  const body = 'Start with one scoped task so its result and reviewer are unambiguous.';
  f.store.command(f.ownerKey, 'commons', { id: 'ask-result', type: 'message.posted', data: { messageId: 'result-parent', body: 'Share the result here', workItemId: 'dot-task' } });
  const posted = await f.rpc('tools/call', { name: 'room_reply', arguments: { requestId: 'dot-result', replyToId: 'result-parent', body, workItemId: 'dot-task' } });
  assert.notEqual(posted.body.result?.isError, true, JSON.stringify(posted.body));
  const message = Object.values(f.store.room('commons').state.messages).find(item => item.body === body);
  assert.ok(message, JSON.stringify(posted.body));
  const event = { id: posted.body.result.structuredContent.eventId };
  const result = await f.rpc('tools/call', { name: 'room_submit_text_result', arguments: { workItemId: 'dot-task', summary: 'A bounded first task', nextAction: 'Review the proposed step', evidenceMessageId: message.id, evidenceMessageEventId: event.id, evidenceVersion: 'sha256:' + createHash('sha256').update(body).digest('hex'), previousCompletionEventId: null, producerId: 'friend-dot' } });
  assert.equal(result.body.error, undefined, JSON.stringify(result.body));
  assert.notEqual(result.body.result?.isError, true, JSON.stringify(result.body));
  assert.equal(f.store.room('commons').state.workItems['dot-task'].state, 'completed');
});

for (const action of ['revoke', 'rotate']) test(`identity ${action} fences issued OAuth access and refresh`, async t => {
  const f = await setup(t);
  f.store.identities[action](f.identity.identityId, f.identity.secret);
  assert.equal((await f.rpc('tools/list')).response.status, 401);
  const refreshed = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource });
  assert.equal(refreshed.status, 400);
});
