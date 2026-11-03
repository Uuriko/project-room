import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { mcpOAuthIdentityEpoch } from '../server/mcp-oauth.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { request } from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
async function setup(t, {legacyOwned=false, client=CLIENT, database=':memory:', clock, normalized=false} = {}) {
  let store = new RoomStore(database);
  if(clock)store.now=clock;
  store.initialize(initialRoom(), normalized ? {representation: 'normalized-current-v1'} : {});
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const ownerSession = store.createSession(ownerKey);
  const accountId = store.db.prepare("SELECT account_id FROM member_accounts WHERE member_id='owner'").get().account_id;
  const accountKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accountKey, 0);
  const identity = store.identities.create('Friend Dot');
  const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
  if (legacyOwned) {
    store.command(ownerKey,'commons',{id:'existing-owned-seat',type:'member.added',data:{memberId:'friend-dot',displayName:'Friend Dot',kind:'agent',identityId:identity.identityId,permissions:['steer','accept_work','complete_work','verify'],accountableHumanId:'owner'}});
    store.identities.link(ownerKey,'commons',{identityId:identity.identityId,memberId:'friend-dot',permissions:['steer','accept_work','complete_work','verify'],identityLinkCode:linkCode});
  } else {
  store.agentConnections.apply(ownerSession.token, 'commons', { action: 'create', requestId: randomUUID(), memberId: 'friend-dot', displayName: 'Friend Dot', access: 'collaborate',
    expectedOwnerRevision: 0, expiresAt: store.now() + 3600000, keyHash: createHash('sha256').update(randomUUID()).digest('hex'), identityId: identity.identityId, identityLinkCode: linkCode }, ownerSession.session.sessionBinding);
  }
  setTier(store.db, 'commons', 'friend-dot', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const binding = { resource, roomId: 'commons', memberId: 'friend-dot', identityId: identity.identityId, humanMemberId: 'owner', identityEpoch: mcpOAuthIdentityEpoch(store, identity.identityId), ...(legacyOwned ? {principalType:'account-owned-agent',accountEpoch:String(store.db.prepare('SELECT auth_epoch FROM accounts WHERE id=?').get(accountId).auth_epoch)} : {}) };
  let server = createRoomServer({ store, origin, mcpOAuthClients: [client] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  let base = `http://127.0.0.1:${server.address().port}`;
  const consent = (changes = {}) => fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Cookie: `__Host-account_session=${slot.token}`, Origin: origin, 'X-CSRF-Token': session.csrf },
    body: JSON.stringify({ decision: 'allow', client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read chat:read chat:write work:read work:write',
      code_challenge: challenge, code_challenge_method: 'S256', resource, agent_binding: JSON.stringify(binding), ...changes }) });
  const exchange = body => fetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const authorized = await consent();
  assert.equal(authorized.status, 302, await authorized.text());
  const code = new URL(authorized.headers.get('location')).searchParams.get('code');
  assert.ok(code, authorized.headers.get('location'));
  const exchanged = await exchange({ grant_type: 'authorization_code', code, client_id: client.clientId, redirect_uri: client.redirectUris[0], code_verifier: verifier, resource });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  const rpc = async (method, params = {}, token = tokens.access_token) => {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }) });
    return { response, body: await response.json() };
  };
  const restart = async () => {
    server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();
    store=new RoomStore(database);if(clock)store.now=clock;
    server=createRoomServer({store,origin,mcpOAuthClients:[client]});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  };
  return { get store(){return store;}, restart, ownerKey, identity, binding, accountId, get base(){return base;}, consent, exchange, tokens, rpc, cookie: `__Host-account_session=${slot.token}` };
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
  const validRefresh = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId });
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

test('mixed native reads require every category while full grants read the real brief', async t => {
  const f = await setup(t);
  const mixed = ['room_read_inbox', 'room_list_work', 'room_read_request', 'room_read_work', 'room_read_work_discussion', 'room_activation_pack'];
  for (const scope of ['rooms:read chat:read', 'rooms:read work:read', 'chat:read work:read']) {
    const consent = await f.consent({ scope });
    const code = new URL(consent.headers.get('location')).searchParams.get('code');
    const exchanged = await f.exchange({ grant_type: 'authorization_code', code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: verifier, resource });
    const token = (await exchanged.json()).access_token;
    const listed = await f.rpc('tools/list', {}, token);
    const names = listed.body.result.tools.map(tool => tool.name);
    const denied = scope === 'chat:read work:read' ? ['room_read_request', 'room_read_work', 'room_activation_pack'] : mixed;
    for (const name of denied) {
      assert.ok(!names.includes(name), `${scope} must not discover ${name}`);
      const called = await f.rpc('tools/call', { name, arguments: { workItemId: 'hidden-work', requestMessageId: 'hidden-request' } }, token);
      assert.match(JSON.stringify(called.body), /outside the connected agent grant/, `${scope}: ${name}`);
    }
    if (scope.includes('chat:read')) assert.ok(names.includes('room_read_messages'));
    if (scope.includes('work:read')) assert.ok(names.includes('room_read_board'));
  }
  const listed = await f.rpc('tools/list');
  assert.ok(listed.body.result.tools.some(tool => tool.name === 'room_activation_pack'));
  const pack = await f.rpc('tools/call', { name: 'room_activation_pack', arguments: {} });
  assert.notEqual(pack.body.result?.isError, true, JSON.stringify(pack.body));
  assert.equal(pack.body.result.structuredContent.room.slug, 'commons');
  assert.equal(pack.body.result.structuredContent.orientation.purpose, f.store.room('commons').state.room.charter?.purpose ?? f.store.room('commons').state.room.purpose ?? '');
});

test('native text schemas accept complete prose under substring and whole-string validators', async t => {
  const f = await setup(t);
  const listed = await f.rpc('tools/list');
  const tools = listed.body.result.tools;
  assert.equal(tools.length, 26, 'audit every advertised native tool, including acquire/release/renew and bounded attention wait');
  const fields = [];
  const inspect = (schema, path) => {
    if (typeof schema?.pattern === 'string') {
      assert.ok(schema.pattern.startsWith('^') && schema.pattern.endsWith('$'), `${path}: portable anchored pattern`);
      if (schema.pattern.includes('\\S')) fields.push({ path, schema });
    }
    for (const [key, value] of Object.entries(schema?.properties ?? {})) inspect(value, `${path}.${key}`);
    if (schema?.items) inspect(schema.items, `${path}[]`);
  };
  for (const tool of tools) inspect(tool.inputSchema, tool.name);
  for (const path of ['room_submit_text_result.summary', 'room_submit_text_result.nextAction',
    'room_submit_text_result.checksClaimed[]', 'room_reply.body']) {
    assert.ok(fields.some(field => field.path === path), `missing audited field ${path}`);
  }
  // Model the reported connector whole-string behavior, without claiming access
  // to its private validator. JSON Schema's ordinary substring behavior must
  // agree for multiline prose, Unicode, and leading/trailing whitespace.
  const submission = { workItemId: 'schema-validation-only', summary: 'Concrete review', nextAction: 'Review the evidence',
    evidenceMessageId: 'schema-message', evidenceMessageEventId: 'schema-event', evidenceVersion: 'sha256:' + 'a'.repeat(64),
    previousCompletionEventId: null, producerId: 'friend-dot' };
  for (const invalid of [{ summary: ' \n' }, { nextAction: '\t' }, { checksClaimed: [' '] }, { summary: 'x'.repeat(4097) }]) {
    const denied = await f.rpc('tools/call', { name: 'room_submit_text_result', arguments: { ...submission, ...invalid } });
    assert.equal(denied.body.error?.code, -32602, 'server still rejects blank/oversized input before mutation');
  }
  for (const { path, schema } of fields) {
    const pattern = new RegExp(schema.pattern, 'u');
    for (const value of ['A useful next step', '  Read the brief.\nThen review the result.  ', 'Café 🪷', 'x', '\n x\n']) {
      assert.equal(pattern.test(value), true, `${path}: ordinary validation`);
      assert.equal(pattern.exec(value)?.[0], value, `${path}: complete-string validation`);
    }
    for (const value of ['', ' ', '\t\r\n', '\u00a0']) assert.equal(pattern.test(value), false, `${path}: refuse blank input`);
  }
});

test('native invitation issuance needs new consent and current room authority without widening old grants',async t=>{
 const f=await setup(t),tool='room_create_agent_invite';
 const scopes='rooms:read chat:read chat:write work:read work:write members:invite';
 const allowed=await f.consent({scope:scopes});assert.equal(allowed.status,302);
 const code=new URL(allowed.headers.get('location')).searchParams.get('code');assert.ok(code,'explicit invitation consent must be supported');
 const response=await f.exchange({grant_type:'authorization_code',code,client_id:CLIENT.clientId,redirect_uri:CLIENT.redirectUris[0],code_verifier:verifier,resource});
 assert.equal(response.status,200);const tokens=await response.json();
 const call=(args={},token=tokens.access_token)=>f.rpc('tools/call',{name:tool,arguments:args},token);
 const inviteCount=()=>f.store.db.prepare("SELECT count(*) AS n FROM agent_invite_codes WHERE room_id='commons'").get().n;
 const before=inviteCount();
 const noAuthority=await call({profile:'chat'});assert.ok(noAuthority.body.error || noAuthority.body.result?.isError);assert.equal(inviteCount(),before);
 let member=f.store.room('commons').state.members['friend-dot'];
 f.store.command(f.ownerKey,'commons',{id:'grant-native-invite',type:'member.access_changed',data:{memberId:member.id,expectedMemberRevision:member.revision,active:true,permissions:[...member.permissions,'invite_member']}});
 // A membership revision intentionally fences its sponsored connection.
 // The owner must explicitly approve a connection rotation at the new revision.
 const owner=f.store.createSession(f.ownerKey),connection=f.store.agentConnections.row('commons','friend-dot');
 member=f.store.room('commons').state.members['friend-dot'];
 f.store.agentConnections.apply(owner.token,'commons',{action:'rotate',requestId:'approve-native-invite-connection',memberId:member.id,
  expectedOwnerRevision:f.store.room('commons').state.members.owner.revision,expectedGeneration:connection.generation,expectedMemberRevision:member.revision,
  keyHash:createHash('sha256').update('synthetic-native-invite-connection').digest('hex'),expiresAt:connection.expires_at},owner.session.sessionBinding);
 const old=await call({profile:'chat'},f.tokens.access_token);assert.ok(old.body.error || old.body.result?.isError);assert.equal(inviteCount(),before,'room authority alone cannot expand existing OAuth consent');
 const oldTools=await f.rpc('tools/list');assert.equal(oldTools.response.status,200);assert.ok(!oldTools.body.result.tools.some(item=>item.name===tool));
 const listed=await f.rpc('tools/list',{},tokens.access_token);assert.ok(listed.body.result.tools.some(item=>item.name===tool));
 const created=await call({profile:'chat'});assert.equal(created.body.error,undefined,JSON.stringify(created.body));assert.notEqual(created.body.result?.isError,true,JSON.stringify(created.body));
 assert.equal(inviteCount(),before+1);const issued=created.body.result.structuredContent;assert.equal(issued.roomId,'commons');assert.equal(issued.ownerEquivalent,false);assert.ok(!issued.permissions.includes('invite_member'));
 for(const args of [{roomId:'other-room',profile:'chat'},{ownerEquivalent:true},{permissions:['invite_member']}]){
  const denied=await call(args);assert.ok(denied.body.error || denied.body.result?.isError);assert.equal(inviteCount(),before+1);
 }
 const widened=await f.exchange({grant_type:'refresh_token',refresh_token:f.tokens.refresh_token,client_id:CLIENT.clientId,resource,scope:scopes});
 assert.equal(widened.status,200);const refreshed=await widened.json();assert.ok(!refreshed.scope.split(' ').includes('members:invite'));
 const refreshTools=await f.rpc('tools/list',{},refreshed.access_token);assert.ok(!refreshTools.body.result.tools.some(item=>item.name===tool));
 member=f.store.room('commons').state.members['friend-dot'];
 f.store.command(f.ownerKey,'commons',{id:'remove-native-invite',type:'member.access_changed',data:{memberId:member.id,expectedMemberRevision:member.revision,active:true,permissions:member.permissions.filter(p=>p!=='invite_member')}});
 const revoked=await call({profile:'chat'});assert.ok(revoked.body.error || revoked.body.result?.isError);assert.equal(inviteCount(),before+1);
});

// Protect the real host discovery -> challenge -> existing-agent retry path.
// Previously a host could initialize and list only public tools, so no listed
// action could reach the already-correct OAuth challenge on room_check_access.
test('anonymous discovery offers existing access check and challenges without creating an identity or seat', async t => {
  const f = await setup(t);
  const counts = () => ({
    identities: f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,
    members: Object.keys(f.store.room('commons').state.members).length,
    credentials: f.store.db.prepare('SELECT count(*) n FROM credentials').get().n,
  });
  const before = counts();
  const initialized = await f.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lazy-auth-host', version: '1' } }, null);
  assert.equal(initialized.response.status, 401);
  assert.match(initialized.response.headers.get('www-authenticate'), /resource_metadata=/);
  const authedBefore = await f.rpc('tools/list');
  const listed = await f.rpc('tools/list', {}, null);
  assert.equal(listed.response.status, 200);
  const entry = listed.body.result.tools.find(tool => tool.name === 'room_check_access');
  assert.ok(entry, 'a public host must discover the existing protected access check');
  assert.deepEqual(entry.inputSchema.required, [], 'OAuth consent selects the room; no guessed room id is needed');
  assert.match(entry.description, /existing/i);
  const publicRead = await f.rpc('tools/call', { name: 'room_join_kits', arguments: {} }, null);
  assert.equal(publicRead.response.status, 200);
  assert.ok(publicRead.body.result);
  const denied = await f.rpc('tools/call', { name: entry.name, arguments: {} }, null);
  assert.equal(denied.response.status, 401);
  assert.equal(denied.response.headers.get('www-authenticate'), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
  assert.equal(denied.body.error.code, -32001);
  const metadata = await fetch(f.base + '/.well-known/oauth-protected-resource/mcp');
  const metadataBody = await metadata.json();
  assert.equal(metadataBody.resource, resource);
  assert.deepEqual(metadataBody.authorization_servers, [origin]);
  const admitted = await f.rpc('tools/call', { name: entry.name, arguments: {} });
  assert.equal(admitted.response.status, 200);
  assert.equal(admitted.body.result.structuredContent.memberId, 'friend-dot');
  assert.equal(admitted.body.result.structuredContent.roomId, 'commons');
  assert.deepEqual((await f.rpc('tools/list')).body.result.tools, authedBefore.body.result.tools, 'public discovery does not change the authenticated catalog');
  assert.deepEqual(counts(), before, 'discovery, refusal and access read create no identity, seat or credential');
});


test('expired refresh HTTP response is invalid_grant and issues no access or identity', async t => {
  const f = await setup(t);
  const accessBefore = f.store.db.prepare('SELECT count(*) n FROM oauth_provider_access_tokens').get().n;
  const identitiesBefore = f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
  const membersBefore = Object.keys(f.store.room('commons').state.members);
  f.store.transaction(() => f.store.db.prepare('UPDATE oauth_provider_refresh_tokens SET expires_at=? WHERE token_hash=?')
    .run(f.store.now(), createHash('sha256').update(f.tokens.refresh_token).digest('hex')));
  const response = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'invalid_grant');
  assert.match(body.error_description, /expired/);
  assert.equal(body.access_token, undefined);
  assert.equal(body.refresh_token, undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_access_tokens').get().n, accessBefore);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_refresh_tokens').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n, identitiesBefore);
  assert.deepEqual(Object.keys(f.store.room('commons').state.members), membersBefore);
  const retry = await f.exchange({ grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource });
  assert.equal(retry.status, 400);
  assert.equal((await retry.json()).error, 'invalid_grant', 'retrying an expired token stays an invalid grant after cleanup');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_access_tokens').get().n, accessBefore);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_refresh_tokens').get().n, 0);
});

for (const problem of ['unknown', 'revoked', 'wrong-client', 'missing-token', 'missing-client']) {
  test(`refresh HTTP refusal for ${problem} preserves authority and the OAuth error contract`, async t => {
    const f = await setup(t);
    const before = {
      access: f.store.db.prepare('SELECT count(*) n FROM oauth_provider_access_tokens').get().n,
      refresh: f.store.db.prepare('SELECT count(*) n FROM oauth_provider_refresh_tokens').get().n,
      identities: f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,
      members: Object.keys(f.store.room('commons').state.members),
    };
    const data = { grant_type: 'refresh_token', refresh_token: f.tokens.refresh_token, client_id: CLIENT.clientId, resource };
    if (problem === 'unknown') data.refresh_token = 'oar_nonexistent_test_credential';
    if (problem === 'wrong-client') data.client_id = 'different-client';
    if (problem === 'missing-token') delete data.refresh_token;
    if (problem === 'missing-client') delete data.client_id;
    if (problem === 'revoked') f.store.transaction(() => f.store.db.prepare('UPDATE oauth_provider_refresh_tokens SET revoked=1 WHERE token_hash=?')
      .run(createHash('sha256').update(f.tokens.refresh_token).digest('hex')));
    const response = await f.exchange(data);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, problem.startsWith('missing-') ? 'invalid_request' : 'invalid_grant');
    assert.equal(body.access_token, undefined);
    assert.equal(body.refresh_token, undefined);
    assert.deepEqual({
      access: f.store.db.prepare('SELECT count(*) n FROM oauth_provider_access_tokens').get().n,
      refresh: f.store.db.prepare('SELECT count(*) n FROM oauth_provider_refresh_tokens').get().n,
      identities: f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,
      members: Object.keys(f.store.room('commons').state.members),
    }, before);
  });
}

const CLAUDE = {clientId:'project-room-claude',name:'Project Room in Claude',redirectUris:['https://claude.ai/api/mcp/auth_callback'],preferredRoomId:'commons',preferredMemberId:'friend-dot'};
test('Claude DCR, existing owned seat consent and grant survive provider restart without a connection key',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'claude-owned-oauth-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let now=Date.now();
 const f=await setup(t,{legacyOwned:true,client:CLAUDE,database:join(directory,'room.sqlite'),clock:()=>now});
 assert.equal(f.store.agentConnections.row('commons','friend-dot'),undefined);
 const before={members:Object.keys(f.store.room('commons').state.members),identities:f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n};
 const metadata=await (await fetch(f.base+'/.well-known/oauth-authorization-server')).json();assert.equal(metadata.registration_endpoint,origin+'/oauth/register');
 const registration=await fetch(f.base+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Claude',redirect_uris:CLAUDE.redirectUris,grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
 assert.equal(registration.status,201);const registered=await registration.json();assert.match(registered.client_id,/^mcp_dcr_/);
 const screen=await fetch(f.base+'/oauth/authorize?'+new URLSearchParams({client_id:registered.client_id,redirect_uri:CLAUDE.redirectUris[0],scope:'rooms:read chat:read chat:write work:read work:write',state:'claude-state',code_challenge:challenge,code_challenge_method:'S256',resource}),{headers:{Cookie:f.cookie}});
 assert.equal(screen.status,200);assert.match(await screen.text(),/account-owned-agent/);
 const consent=await f.consent({client_id:registered.client_id});assert.equal(consent.status,302);const code=new URL(consent.headers.get('location')).searchParams.get('code');assert.ok(code);
 const exchange=await f.exchange({grant_type:'authorization_code',code,client_id:registered.client_id,redirect_uri:CLAUDE.redirectUris[0],code_verifier:verifier,resource});assert.equal(exchange.status,200);const pair=await exchange.json();assert.ok(pair.refresh_token);
 const access=await f.rpc('tools/call',{name:'room_check_access',arguments:{}},pair.access_token);assert.equal(access.response.status,200);assert.equal(access.body.result.structuredContent.memberId,'friend-dot');
 const tools=await f.rpc('tools/list',{},pair.access_token);for(const name of ['room_read_inbox','room_read_board','room_post_message','room_acquire_claim','room_release_claim'])assert.ok(tools.body.result.tools.some(tool=>tool.name===name),name);
 assert.deepEqual(Object.keys(f.store.room('commons').state.members),before.members);assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,before.identities);
 const wrong=await f.exchange({grant_type:'refresh_token',refresh_token:pair.refresh_token,client_id:registered.client_id,resource:'https://evil.example/mcp'});assert.equal(wrong.status,400);
 const otherOwner=await f.consent({agent_binding:JSON.stringify({...f.binding,humanMemberId:'stranger'})});assert.match(new URL(otherOwner.headers.get('location')).search,/access_denied/);

 f.store.command(f.ownerKey,'commons',{id:'owned-task-propose',type:'work.proposed',data:{workItemId:'owned-task',title:'Deliver one scoped change',definitionOfDone:'Save one reviewed useful result',accountableMemberId:'friend-dot',mode:'write',independentVerificationRequired:false,ownerDecisionRequired:false}});
 const action=async(name,args)=>{const r=await f.rpc('tools/call',{name,arguments:args},pair.access_token);assert.equal(r.response.status,200);assert.equal(r.body.error,undefined,JSON.stringify(r.body));assert.notEqual(r.body.result?.isError,true,JSON.stringify(r.body));return r;};
 await action('room_accept_work',{workItemId:'owned-task'});
 await action('room_acquire_claim',{roomId:'commons',workItemId:'owned-task',repository:'Uuriko/project-room',ref:'codex/owned-task',paths:['example.txt'],expiresAt:new Date(now+3600000).toISOString()});
 assert.equal(f.store.room('commons').state.workItems['owned-task'].claim.holderId,'friend-dot');
 await action('room_release_claim',{roomId:'commons',workItemId:'owned-task'});
 assert.equal(f.store.room('commons').state.workItems['owned-task'].claim.status,'released');
 await action('room_post_message',{body:'Useful work from the existing Claude seat'});
 assert.equal(f.store.room('commons').state.messages.find(m=>m.body==='Useful work from the existing Claude seat').authorId,'friend-dot');
 let nextPair=pair;
 for(let round=0;round<3;round++) {
  now+=29*86400000;await f.restart();
  assert.equal((await f.rpc('tools/list',{},nextPair.access_token)).response.status,401,'expired access challenges');
  const refreshed=await f.exchange({grant_type:'refresh_token',refresh_token:nextPair.refresh_token,client_id:registered.client_id,...(round===1?{resource}:{})});assert.equal(refreshed.status,200);nextPair=await refreshed.json();
  const check=await f.rpc('tools/call',{name:'room_check_access',arguments:{}},nextPair.access_token);assert.equal(check.body.result.structuredContent.memberId,'friend-dot');
 }
 assert.equal(f.store.agentConnections.row('commons','friend-dot'),undefined);
 assert.deepEqual(Object.keys(f.store.room('commons').state.members),before.members);

 const bad=await fetch(f.base+'/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:['https://claude.ai.attacker.invalid/api/mcp/auth_callback']})});assert.equal(bad.status,400);

});

test('interrupted refresh saves roll back; successful refresh reuse still revokes its family over HTTP',async t=>{
 const f=await setup(t,{legacyOwned:true,client:CLAUDE});
 const counts=()=>Object.fromEntries(['oauth_provider_access_tokens','oauth_provider_refresh_tokens'].map(table=>[table,f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
 const before=counts(),prepare=f.store.db.prepare.bind(f.store.db);let fired=false;
 f.store.db.prepare=sql=>{
  const stmt=prepare(sql);
  if(!fired&&/^\s*INSERT INTO oauth_provider_refresh_tokens/.test(sql)){
   const run=stmt.run.bind(stmt);stmt.run=(...args)=>{if(!fired){fired=true;throw Error('synthetic interrupted refresh save');}return run(...args);};
  }
  return stmt;
 };
 const input={grant_type:'refresh_token',refresh_token:f.tokens.refresh_token,client_id:CLAUDE.clientId,resource};
 try{assert.equal((await f.exchange(input)).status,500);}finally{f.store.db.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(counts(),before);
 const refreshed=await f.exchange(input);assert.equal(refreshed.status,200);const next=await refreshed.json();
 assert.equal((await f.rpc('tools/list',{},next.access_token)).response.status,200);
 assert.equal((await f.exchange(input)).status,400);
 assert.equal((await f.rpc('tools/list',{},next.access_token)).response.status,401,'replay revocation is committed, not rolled back with protocol refusal');
});

test('owned-seat consent is fenced by owner transfer, membership removal and identity rotation',async t=>{
 for(const change of ['owner','member','identity','accountEpoch']){
  const f=await setup(t,{legacyOwned:true,client:CLAUDE});
  if(change==='owner'){
   f.store.command(f.ownerKey,'commons',{id:'successor',type:'member.added',data:{memberId:'successor',displayName:'Successor',kind:'human',permissions:[]}});
   f.store.command(f.ownerKey,'commons',{id:'transfer',type:'ownership.transferred',data:{toMemberId:'successor'}});
  }else if(change==='member'){
   const member=f.store.room('commons').state.members['friend-dot'];
   f.store.command(f.ownerKey,'commons',{id:'remove',type:'member.access_changed',data:{memberId:member.id,expectedMemberRevision:member.revision,active:false,permissions:member.permissions}});
  }else if(change==='accountEpoch')f.store.db.prepare('UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?').run(f.accountId);
  else f.store.identities.rotate(f.identity.identityId,f.identity.secret);
  assert.equal((await f.rpc('tools/list')).response.status,401,change);
  assert.equal((await f.exchange({grant_type:'refresh_token',refresh_token:f.tokens.refresh_token,client_id:CLAUDE.clientId,resource})).status,400,change);
 }
});

test('in-flight consent cannot issue a code after browser account-slot logout',async t=>{
 const f=await setup(t,{legacyOwned:true,client:CLAUDE});
 const slotToken=f.cookie.split('=')[1],auth=f.store.authenticateAccountSession(slotToken),before=f.store.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n;
 const payload=JSON.stringify({decision:'allow',client_id:CLAUDE.clientId,redirect_uri:CLAUDE.redirectUris[0],scope:'rooms:read chat:read',state:'late',code_challenge:challenge,code_challenge_method:'S256',resource,agent_binding:JSON.stringify(f.binding)});
 let entered;const authenticated=new Promise(resolve=>entered=resolve),original=f.store.authenticateAccountSession.bind(f.store);
 f.store.authenticateAccountSession=(...args)=>{const value=original(...args);entered();return value;};
 let req;const response=new Promise((resolve,reject)=>{req=request(f.base+'/oauth/authorize',{method:'POST',headers:{Host:'room.example',Origin:origin,Cookie:f.cookie,'X-CSRF-Token':auth.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.write(payload.slice(0,1));});
 await authenticated;f.store.logoutAccountSession(slotToken,f.store.accountSessionSlot(slotToken).sessionRevision);req.end(payload.slice(1));
 const denied=await response;assert.equal(denied.status,401,denied.text);assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n,before);
 f.store.authenticateAccountSession=original;
});

test('Claude defaults to existing-account consent while explicit invitation and public discovery remain available',async t=>{
 const f=await setup(t,{legacyOwned:true,client:CLAUDE});
 const args={client_id:CLAUDE.clientId,redirect_uri:CLAUDE.redirectUris[0],scope:'rooms:read chat:read',state:'claude',code_challenge:challenge,code_challenge_method:'S256',resource};
 const account=await fetch(f.base+'/oauth/authorize?'+new URLSearchParams(args));assert.equal(account.status,302);assert.match(account.headers.get('location'),/oauth=login/);
 const invitation=await fetch(f.base+'/oauth/authorize?'+new URLSearchParams({...args,connection:'invite'}));assert.equal(invitation.status,200);
 const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Claude discovery',version:'1'}}};
 const discovery=await fetch(f.base+'/mcp?auth=discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(init)});assert.equal(discovery.status,200);assert.ok((await discovery.json()).result.capabilities.tools);
});

test('Claude consent POST refuses another valid owned seat and never issues a code', async t => {
 const f=await setup(t,{legacyOwned:true,client:CLAUDE});
 const identity=f.store.identities.create('Other owned agent');
 const {linkCode}=f.store.identities.mintLinkCode(identity.identityId,identity.secret,{roomId:'commons'});
 f.store.command(f.ownerKey,'commons',{id:'other-owned-seat',type:'member.added',data:{memberId:'other-agent',displayName:'Other owned agent',kind:'agent',identityId:identity.identityId,permissions:[],accountableHumanId:'owner'}});
 f.store.identities.link(f.ownerKey,'commons',{identityId:identity.identityId,memberId:'other-agent',permissions:[],identityLinkCode:linkCode});
 const binding={...f.binding,memberId:'other-agent',identityId:identity.identityId,identityEpoch:mcpOAuthIdentityEpoch(f.store,identity.identityId)};
 const before=f.store.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n;
 const denied=await f.consent({agent_binding:JSON.stringify(binding)});
 const redirect=new URL(denied.headers.get('location'));
 assert.equal(redirect.searchParams.get('error'),'access_denied');
 assert.equal(redirect.searchParams.has('code'),false);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n,before);
 const allowed=await f.consent();assert.ok(new URL(allowed.headers.get('location')).searchParams.get('code'));
});


test('OAuth inbox reply actions use the connected MCP tool and preserve private recipients', async t => {
  const f = await setup(t,{normalized:true});
  f.store.command(f.ownerKey,'commons',{id:'add-outsider',type:'member.added',data:{memberId:'guest',displayName:'Outsider',kind:'agent',permissions:[]}});
  const say = (id,body,toMemberId) => f.store.command(f.ownerKey,'commons',{id,type:'message.posted',data:{messageId:id,body,...(toMemberId?{toMemberId}:{})}});
  f.store.dmConsents.request('commons','owner','friend-dot','test');
  f.store.dmConsents.decide('commons','friend-dot','owner','approve');
  say('oauth-public-mention','<@friend-dot> public question');
  say('oauth-private-mention','<@friend-dot> private question','friend-dot');
  const read = await f.rpc('tools/call',{name:'room_read_inbox',arguments:{roomId:'commons',limit:100}});
  assert.notEqual(read.body.result?.isError,true,JSON.stringify(read.body));
  const inbox=read.body.result.structuredContent, mention=inbox.next.find(step=>step.action==='reply-mention');
  assert.equal(mention.tool,'room_reply');
  assert.equal(mention.arguments.replyToId,'oauth-private-mention');
  assert.equal(mention.arguments.toMemberId,'owner');
  assert.doesNotMatch(mention.description,/send your identity secret/i);
  assert.match(mention.description,/existing authenticated MCP connection/);
  const dm=inbox.next.find(step=>step.action==='reply-dm');
  assert.equal(dm.tool,'room_reply');assert.equal(dm.arguments.replyToId,'oauth-private-mention');
  assert.equal(dm.arguments.toMemberId,'owner');
  const reply=await f.rpc('tools/call',{name:mention.tool,arguments:{...mention.arguments,requestId:'oauth-private-answer',body:'Private answer through existing OAuth'}});
  assert.notEqual(reply.body.result?.isError,true,JSON.stringify(reply.body));assert.equal(reply.body.error,undefined);
  const saved=f.store.db.prepare("SELECT body,to_member_id FROM messages WHERE room_id='commons' AND message_id=?").get(reply.body.result.structuredContent.messageId);
  assert.equal(saved.to_member_id,'owner');assert.equal(saved.body,'Private answer through existing OAuth');
  const guest=f.store.issueAccessKey('commons','guest');
  assert.equal(JSON.stringify(f.store.eventsAfter(guest,'commons',0,100)).includes('Private answer through existing OAuth'),false);
  const next=await f.rpc('tools/call',{name:'room_read_inbox',arguments:{roomId:'commons',limit:100}});
  const publicAction=next.body.result.structuredContent.next.find(step=>step.action==='reply-mention');
  assert.equal(publicAction.arguments.replyToId,'oauth-public-mention');assert.equal(publicAction.arguments.toMemberId,undefined);
});

test('OAuth help_wanted gives a truthful supported pointer without scanning or implying an empty queue', async t => {
  const f=await setup(t,{normalized:true});
  for(let i=0;i<32;i++)f.store.command(f.ownerKey,'commons',{id:'noise-'+i,type:'work.proposed',data:{workItemId:'noise-'+i,title:'Other work '+i,definitionOfDone:'Useful answer',mode:'read',accountableMemberId:'owner'}});
  f.store.command(f.ownerKey,'commons',{id:'addressed-work',type:'work.proposed',data:{workItemId:'addressed-work',title:'Your useful next step',definitionOfDone:'Useful answer',mode:'read',accountableMemberId:'friend-dot'}});
  f.store.command(f.ownerKey,'commons',{id:'addressed-request',type:'message.posted',data:{messageId:'addressed-request',toMemberId:'friend-dot',requestKind:'reply',body:'Please inspect your next step'}});
  f.store.room=()=>{throw Error('whole-room hydration');};f.store.snapshot=()=>{throw Error('whole snapshot');};
  const before=f.store.db.prepare('SELECT count(*) n FROM events').get().n;
  const read=await f.rpc('tools/call',{name:'room_list_work',arguments:{roomId:'commons',focus:'help_wanted',limit:100}});
  assert.notEqual(read.body.result?.isError,true,JSON.stringify(read.body));assert.equal(read.body.error,undefined);
  const value=read.body.result.structuredContent;
  assert.equal(value.status,'selection_unavailable');assert.equal(value.selection.available,false);
  assert.equal(value.selection.requestedFocus,'help_wanted');assert.equal(value.selection.reason,'current_help_index_unavailable');
  assert.match(value.selection.guidance,/does not mean no invitations exist/);
  for(const key of ['work','page','nextCursor','totalWork'])assert.equal(Object.hasOwn(value,key),false,key+' must not imply an empty queue');
  assert.equal(value.viewerId,'friend-dot');assert.equal(value.scope.externalExecution,false);
  assert.deepEqual(value.nextRead,{tool:'room_list_work',arguments:{roomId:'commons',focus:'needs_me'}});
  const next=await f.rpc('tools/call',{name:value.nextRead.tool,arguments:value.nextRead.arguments});
  assert.notEqual(next.body.result?.isError,true,JSON.stringify(next.body));
  assert.deepEqual(next.body.result.structuredContent.work.map(item=>item.id),['addressed-work']);
  assert.deepEqual(next.body.result.structuredContent.replyRequests.map(item=>item.id),['addressed-request']);
  assert.equal(next.body.result.structuredContent.page.hasMore,false);
  const selected=await f.rpc('tools/call',{name:'room_read_work',arguments:{workItemId:'addressed-work'}});
  assert.notEqual(selected.body.result?.isError,true,JSON.stringify(selected.body));
  const all=await f.rpc('tools/call',{name:value.alternatives[0].tool,arguments:value.alternatives[0].arguments});
  assert.notEqual(all.body.result?.isError,true,JSON.stringify(all.body));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,before,'discovery and selected reads write no events');
});
