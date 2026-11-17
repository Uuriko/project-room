import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { mcpOAuthIdentityEpoch, mcpOAuthToolAllowed } from '../server/mcp-oauth.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';
import { request } from 'node:http';
import { connectionCapability, oauthScopesForTool } from '../server/mcp-next-capability.mjs';

// Effective next-action capability on selected work reads (agent-interface
// trial 2026-11-16): a continuation that names a tool this connection cannot
// call must say so, with the reason and a recovery, before the agent tries it.
// Setup mirrors tests/mcp-oauth-http.test.js (kept separate: that file is in another lane).
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

const verifyAllowedByOAuth = mcpOAuthToolAllowed('room_record_verification', ['rooms:read', 'chat:read', 'chat:write', 'work:read', 'work:write']);
const call = (f, name, args, token) => f.rpc('tools/call', { name, arguments: args }, token);
const refused = response => Boolean(response.body.error || response.body.result?.isError);
function reviewFixture(f, workItemId, { verifier = 'friend-dot' } = {}) {
  const command = (id, type, data) => f.store.command(f.ownerKey, 'commons', { id: `${workItemId}-${id}`, type, data });
  command('propose', 'work.proposed', { workItemId, title: 'Review an exact result', definitionOfDone: 'Independent review of stored text',
    accountableMemberId: 'owner', verifierMemberId: verifier, mode: 'read', independentVerificationRequired: true, ownerDecisionRequired: false });
  command('accept', 'work.accepted', { workItemId, expectedRevision: 0 });
  const body = `Exact contribution for ${workItemId}`;
  const posted = command('post', 'message.posted', { messageId: `${workItemId}-result`, workItemId, body });
  const evidenceVersion = 'sha256:' + createHash('sha256').update(body).digest('hex');
  const completed = command('complete', 'work.completed', { workItemId, expectedRevision: 1, evidenceKind: 'room_text',
    evidenceMessageId: `${workItemId}-result`, evidenceMessageEventId: posted.event.id, evidenceVersion, previousCompletionEventId: null,
    producerId: 'owner', summary: 'Result ready', nextAction: 'Independent review' });
  return { workItemId, expectedRevision: 2, completionEventId: completed.event.id, evidenceVersion, result: 'pass', summary: 'Inspected exact stored result' };
}
async function readOnlyToken(f) {
  const consent = await f.consent({ scope: 'rooms:read chat:read work:read' });
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const response = await f.exchange({ grant_type: 'authorization_code', code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: verifier, resource });
  return (await response.json()).access_token;
}

for (const normalized of [false, true]) test(`selected work read states whether this connection can record the review (${normalized ? 'normalized' : 'legacy'})`, async t => {
  const f = await setup(t, { normalized });
  const args = reviewFixture(f, 'cap-review');
  const read = await call(f, 'room_read_work', { workItemId: args.workItemId, brief: true });
  assert.equal(read.body.error, undefined, JSON.stringify(read.body));
  const { continuation } = read.body.result.structuredContent;
  assert.equal(continuation.action, 'verify');
  const capability = continuation.capability;
  assert.equal(capability.tool, 'room_record_verification');
  assert.equal(capability.room, 'permitted');
  assert.equal(capability.connection.kind, 'oauth');
  assert.equal(capability.connection.exposed, true);
  assert.doesNotMatch(JSON.stringify(capability), /oat_|iat_|secret|token/i, 'no credential material');
  if (verifyAllowedByOAuth) {
    assert.equal(capability.status, 'available');
  } else {
    assert.equal(capability.status, 'blocked');
    assert.equal(capability.blockedBy, 'oauth_not_offered');
    assert.match(capability.recovery, /reconnecting will not help/);
  }
  // A read-only grant: Room authority unchanged, this grant cannot act.
  const token = await readOnlyToken(f);
  const limited = await call(f, 'room_read_work', { workItemId: args.workItemId, brief: true }, token);
  const limitedCapability = limited.body.result.structuredContent.continuation.capability;
  assert.equal(limitedCapability.room, 'permitted', 'Room authority is unchanged by the grant');
  assert.equal(limitedCapability.status, 'blocked');
  if (verifyAllowedByOAuth) {
    assert.equal(limitedCapability.blockedBy, 'oauth_scope');
    assert.deepEqual(limitedCapability.connection.missingScopes, ['work:write']);
    assert.match(limitedCapability.recovery, /approve work:write; keep the existing identity/);
  } else assert.equal(limitedCapability.blockedBy, 'oauth_not_offered');
  assert.equal(refused(await call(f, 'room_record_verification', { ...args, requestId: 'cap-review-ro' }, token)), true, 'the read-only grant is refused as stated');
  // The statement must predict the actual call on this connection.
  const actual = await call(f, 'room_record_verification', { ...args, requestId: 'cap-review-call' });
  assert.equal(refused(actual), capability.status !== 'available', JSON.stringify(actual.body));
  if (capability.status === 'blocked') assert.match(JSON.stringify(actual.body), /outside the connected agent grant/);

});

test('a designated verifier without Room verify authority is told so instead of being sent to the tool', async t => {
  const f = await setup(t);
  const args = reviewFixture(f, 'cap-no-verify');
  const member = f.store.room('commons').state.members['friend-dot'];
  f.store.command(f.ownerKey, 'commons', { id: randomUUID(), type: 'member.access_changed', data: { memberId: member.id, expectedMemberRevision: member.revision,
    active: true, permissions: member.permissions.filter(permission => permission !== 'verify') } });
  // A permission change retires the OAuth grant (existing epoch rule); read with the identity secret.
  const read = await call(f, 'room_read_work', { roomId: 'commons', workItemId: args.workItemId, brief: true }, f.identity.secret);
  assert.equal(read.body.error, undefined, JSON.stringify(read.body));
  const { continuation } = read.body.result.structuredContent;
  assert.equal(continuation.tool, null);
  assert.equal(continuation.capability.room, 'not_permitted');
  assert.equal(continuation.capability.status, 'blocked');
  assert.equal(continuation.capability.blockedBy, 'room_authority');
  assert.equal(continuation.capability.connection.kind, 'identity', 'the connection is still reported separately');
  assert.equal(refused(await call(f, 'room_record_verification', { roomId: 'commons', ...args, requestId: 'cap-no-verify' }, f.identity.secret)), true, 'the service agrees');
});

test('an OAuth producer gets an executable stage when the composite begin is not offered', async t => {
  const f = await setup(t);
  const workItemId = 'cap-produce';
  f.store.command(f.ownerKey, 'commons', { id: 'cap-produce-propose', type: 'work.proposed', data: { workItemId, title: 'Produce a result', definitionOfDone: 'Stored text',
    accountableMemberId: 'friend-dot', verifierMemberId: 'owner', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false } });
  let calls = 0, failed = 0;
  for (const expected of ['accept', 'start']) {
    const read = await call(f, 'room_read_work', { workItemId, brief: true }); calls++;
    const { continuation } = read.body.result.structuredContent;
    assert.equal(continuation.action, expected);
    assert.equal(continuation.tool, 'room_begin_work', 'the existing continuation is unchanged');
    const capability = continuation.capability;
    const beginOffered = mcpOAuthToolAllowed('room_begin_work', ['work:write']);
    if (beginOffered) { assert.equal(capability.status, 'available'); return; }
    assert.equal(capability.connection.grant, 'not_offered');
    assert.equal(capability.via, 'alternative');
    assert.equal(capability.alternative.tool, expected === 'accept' ? 'room_accept_work' : 'room_start_work');
    const begin = await call(f, 'room_begin_work', { workItemId }, undefined);
    assert.equal(refused(begin), true, 'the composite really is refused on this connection'); calls++; failed++;
    const stage = await call(f, capability.alternative.tool, { ...capability.alternative.arguments }); calls++;
    assert.equal(refused(stage), false, JSON.stringify(stage.body));
  }
  assert.equal(f.store.room('commons').state.workItems[workItemId].state, 'working');
  assert.deepEqual({ calls, failed }, { calls: 6, failed: 2 }, 'the refused begin calls here only prove the statement; an agent following capability skips them');
});

test('an identity-secret connection reports no OAuth limit and records the exact review', async t => {
  const f = await setup(t);
  const args = reviewFixture(f, 'cap-identity');
  const read = await call(f, 'room_read_work', { roomId: 'commons', workItemId: args.workItemId, brief: true, includeResult: true }, f.identity.secret);
  assert.equal(read.body.error, undefined, JSON.stringify(read.body));
  const { continuation } = read.body.result.structuredContent;
  assert.equal(continuation.tool, 'room_record_verification');
  assert.deepEqual(continuation.capability.connection, { kind: 'identity', exposed: true, grant: 'not_applicable' });
  assert.equal(continuation.capability.status, 'available');
  assert.equal(continuation.arguments.evidenceVersion, args.evidenceVersion);
  const stale = await call(f, 'room_record_verification', { ...continuation.arguments, result: 'pass', summary: 'ok', evidenceVersion: 'sha256:' + '0'.repeat(64), requestId: 'cap-stale' }, f.identity.secret);
  assert.equal(refused(stale), true, 'available never bypasses the exact-version check');
  const recorded = await call(f, 'room_record_verification', { ...continuation.arguments, result: 'pass', summary: 'Inspected exact stored result', requestId: 'cap-identity' }, f.identity.secret);
  assert.equal(refused(recorded), false, JSON.stringify(recorded.body));
});

test('scope derivation and statuses come only from the existing allowlist', () => {
  const allow = (table, composite = {}) => (name, scopes) => composite[name] ? composite[name].every(s => scopes.includes(s))
    : Object.entries(table).some(([scope, names]) => scopes.includes(scope) && names.includes(name));
  const repaired = allow({ 'work:write': ['room_record_verification'] });
  assert.deepEqual(oauthScopesForTool('room_record_verification', repaired), { allOf: ['work:write'] });
  assert.equal(oauthScopesForTool('room_record_verification', allow({})), null);
  assert.deepEqual(oauthScopesForTool('room_read_work', allow({}, { room_read_work: ['rooms:read', 'chat:read', 'work:read'] })), { allOf: ['rooms:read', 'chat:read', 'work:read'] });
  const continuation = { workRevision: 2, arguments: { workItemId: 'x' }, capability: { operation: 'verify', tool: 'room_record_verification', room: 'permitted', status: 'unknown', blockedBy: null, recovery: null, connection: 'not_evaluated' } };
  const exposed = () => true;
  const missing = connectionCapability(continuation, { connection: { kind: 'oauth', scopes: ['work:read'] }, exposed, allowed: repaired }).capability;
  assert.deepEqual([missing.status, missing.blockedBy, missing.connection.missingScopes], ['blocked', 'oauth_scope', ['work:write']]);
  assert.match(missing.recovery, /approve work:write/);
  assert.equal(connectionCapability(continuation, { connection: { kind: 'oauth', scopes: ['work:write'] }, exposed, allowed: repaired }).capability.status, 'available');
  const apiKey = connectionCapability(continuation, { connection: { kind: 'api_key' }, exposed, allowed: repaired }).capability;
  assert.equal(apiKey.status, 'unknown', 'unknown stays distinct from false');
  const tier = connectionCapability(continuation, { connection: { kind: 'identity' }, exposed: () => false, allowed: repaired }).capability;
  assert.deepEqual([tier.status, tier.blockedBy, tier.connection.grant], ['blocked', 'catalog', 'unknown']);
  const roomBlocked = { ...continuation, capability: { ...continuation.capability, room: 'not_permitted', status: 'blocked', blockedBy: 'room_authority' } };
  assert.equal(connectionCapability(roomBlocked, { connection: { kind: 'oauth', scopes: ['work:write'] }, exposed, allowed: repaired }).capability.blockedBy, 'room_authority');
});
