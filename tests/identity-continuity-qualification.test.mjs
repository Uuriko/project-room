// Finite synthetic qualification: existing Room principals are proved by
// saved credentials, never inferred from provider, browser user or display name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { main } from '../room-acp/src/cli.mjs';
import { RoomClient } from '../room-acp/src/room.mjs';
import { loadConnection } from '../room-acp/src/credentials.mjs';
import { startRoom } from './room-acp-fixture.mjs';

const counts = f => ({
  identities: f.f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,
  agentMembers: Object.values(f.f.store.room('commons').state.members).filter(m => m.kind === 'agent').length,
  identityLinks: f.f.store.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='commons'").get().n
});
const cliJoin = (f, link, name, extra = [], fetchImpl = undefined) => main([link, '--name', name, ...extra], { env: f.env, print() {}, joinOnly: true, fetchImpl });

test('first Room enrollment and exact same-invitation retry legitimately preserve one newly enrolled principal', async t => {
  const f = await startRoom(t), invite = f.invite(), before = counts(f);
  assert.equal(await cliJoin(f, invite.link, 'Synthetic first enrollment'), 0);
  const saved = loadConnection({}, f.env), enrolled = counts(f);
  assert.equal(enrolled.identities, before.identities + 1); assert.equal(enrolled.agentMembers, before.agentMembers + 1);
  await new RoomClient({ ...saved }).checkConnection(); // Actual server proves this saved principal.
  assert.equal(await cliJoin(f, invite.link, 'Synthetic first enrollment'), 0);
  assert.deepEqual(counts(f), enrolled);
  const again = loadConnection({}, f.env);
  assert.equal(again.identityId, saved.identityId); assert.equal(again.memberId, saved.memberId);
});

test('explicitly authenticated RoomClient existing identity refuses a redundant invitation without a duplicate or code burn', async t => {
  const f = await startRoom(t), first = f.invite();
  assert.equal(await cliJoin(f, first.link, 'Synthetic authenticated existing agent'), 0);
  const saved = loadConnection({}, f.env), existing = new RoomClient({ ...saved });
  await existing.checkConnection();
  const before = counts(f), invitation = f.invite();
  await assert.rejects(existing.redeem({ code: invitation.code, displayName: 'Synthetic different display label', requestId: 'existing-principal-control' }),
    error => error.status === 409 && error.code === 'identity_already_linked');
  assert.deepEqual(counts(f), before);
  assert.equal(f.f.store.invites.preview(invitation.code).roomId, 'commons');
  const after = loadConnection({}, f.env); assert.equal(after.identityId, saved.identityId); assert.equal(after.memberId, saved.memberId);
});

test('MVP guard: CLI selecting an already verified saved room must not silently replace its principal on a fresh invitation', async t => {
  const f = await startRoom(t), first = f.invite();
  assert.equal(await cliJoin(f, first.link, 'Synthetic already connected agent'), 0);
  const saved = loadConnection({}, f.env); await new RoomClient({ ...saved }).checkConnection();
  const savedPath = pathJoin(f.home, 'commons.json'), originalBytes = readFileSync(savedPath);
  const before = counts(f), second = f.invite();
  let existingCredentialForwarded = false;
  const observedFetch = (url, options) => {
    if (url.endsWith('/api/agent-invites/redeem')) existingCredentialForwarded = Boolean(options.headers.authorization);
    return fetch(url, options);
  };
  const result = await cliJoin(f, second.link, 'Synthetic renamed display label', ['--room', 'commons'], observedFetch);
  const after = loadConnection({}, f.env), afterFirst = counts(f);
  const retry = await cliJoin(f, second.link, 'Synthetic renamed display label', ['--room', 'commons']);
  const afterRetry = counts(f);
  await new RoomClient({ ...saved }).checkConnection(); // Old principal remains active, not migrated/merged.
  await new RoomClient({ ...after }).checkConnection();
  t.diagnostic(JSON.stringify({ scenario: 'explicit-saved-room-selection', result, retry, before, afterFirst, afterRetry,
    existingCredentialForwarded, identityPreserved: after.identityId === saved.identityId, memberPreserved: after.memberId === saved.memberId,
    savedBytesPreserved: originalBytes.equals(readFileSync(savedPath)), originalSavedCredentialStillActive: true }));
  assert.deepEqual(afterRetry, afterFirst, 'exact same-invitation retry must not add another principal');
  const refusedWithoutReplacement = result !== 0 && originalBytes.equals(readFileSync(savedPath));
  const attachedExisting = after.identityId === saved.identityId && after.memberId === saved.memberId;
  assert.equal(refusedWithoutReplacement || attachedExisting, true,
    'guard requires either preserving the explicitly selected saved principal or refusing without overwriting it; not an authorization to merge identities');
});

// Account OAuth is the supported existing-agent choice. Accountless invitation
// consent deliberately enrolls a new Room principal and is not identity proof.
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { mcpOAuthIdentityEpoch } from '../server/mcp-oauth.mjs';
const nativeFetch = (url, options = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method: options.method ?? 'GET', headers: { Host: 'room.example', ...options.headers } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject); req.end(options.body?.toString());
});
test('supported native account consent selects an already proved agent and repeated consent/refresh never creates another principal', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner'), ownerSession = store.createSession(ownerKey);
  const accountId = store.accountForMember('commons', 'owner').id, accountKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot(), session = store.loginAccountSession(slot.token, accountKey, 0);
  const identity = store.identities.create('Synthetic proved native identity');
  const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
  store.agentConnections.apply(ownerSession.token, 'commons', { action: 'create', requestId: randomUUID(), memberId: 'synthetic-native-agent',
    displayName: 'Synthetic proved native identity', access: 'collaborate', expectedOwnerRevision: 0, expiresAt: store.now() + 3600000,
    keyHash: createHash('sha256').update('synthetic-local-room-key').digest('hex'), identityId: identity.identityId, identityLinkCode: linkCode }, ownerSession.session.sessionBinding);
  const origin = 'https://room.example', resource = origin + '/mcp';
  const client = { clientId: 'synthetic-continuity', name: 'Synthetic native continuity', redirectUris: ['https://client.example/callback'] };
  const verifier = 'v'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
  const binding = { resource, roomId: 'commons', identityId: identity.identityId, memberId: 'synthetic-native-agent', humanMemberId: 'owner', identityEpoch: mcpOAuthIdentityEpoch(store, identity.identityId) };
  const server = createRoomServer({ store, origin, mcpOAuthClients: [client] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, cookie = `__Host-account_session=${slot.token}`;
  const current = () => ({ identities: store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,
    members: Object.values(store.room('commons').state.members).length, links: store.db.prepare('SELECT count(*) n FROM identity_links').get().n });
  const before = current();
  const screen = await nativeFetch(base + '/oauth/authorize?' + new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0],
    connection: 'account', scope: 'rooms:read', state: 'continuity', code_challenge: challenge, code_challenge_method: 'S256', resource }), { headers: { Cookie: cookie } });
  assert.equal(screen.status, 200); assert.match(await screen.text(), /name="agent_binding"/);
  const consent = () => nativeFetch(base + '/oauth/authorize', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
    body: JSON.stringify({ decision: 'allow', client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read', state: 'continuity',
      code_challenge: challenge, code_challenge_method: 'S256', resource, agent_binding: JSON.stringify(binding) }) });
  const exchange = fields => nativeFetch(base + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, resource, ...fields }) });
  let last;
  for (let index = 0; index < 2; index++) {
    const allowed = await consent(); assert.equal(allowed.status, 302);
    const code = new URL(allowed.headers.get('location')).searchParams.get('code'); assert.ok(code);
    const exchanged = await exchange({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUris[0], code_verifier: verifier });
    assert.equal(exchanged.status, 200); last = await exchanged.json();
    assert.deepEqual(current(), before);
  }
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: last.refresh_token }); assert.equal(refreshed.status, 200);
  const tokens = await refreshed.json();
  const accessed = await nativeFetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.access_token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'room_check_access', arguments: {} } }) });
  assert.equal(accessed.status, 200);
  const body = await accessed.json(); assert.equal(body.result.structuredContent.memberId, binding.memberId);
  assert.deepEqual(current(), before);
  t.diagnostic(JSON.stringify({ scenario: 'native-supported-existing-agent-account-consent', before, after: current(), repeatedConsents: 2,
    identityPreserved: true, memberPreserved: true, refreshSucceeded: true }));
});

test('existing authenticated RoomClient joins a second room and retry recovers the same identity/member', async t => {
  const f = await startRoom(t);
  assert.equal(await cliJoin(f, f.invite().link, 'Synthetic multi-room identity'), 0);
  const saved = loadConnection({}, f.env); await new RoomClient({ ...saved }).checkConnection();
  f.f.store.initialize(initialRoom('second'));
  const owner = f.f.store.issueAccessKey('second', 'owner');
  const invitation = f.f.store.invites.create(owner, 'second', { profile: 'contribute' });
  const before = f.f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
  const existing = () => new RoomClient({ apiBase: f.origin, identitySecret: saved.identitySecret });
  const request = { code: invitation.code, displayName: 'Synthetic multi-room identity', requestId: 'existing-second-room' };
  const connected = await existing().redeem(request);
  const retry = await existing().redeem(request);
  assert.equal(connected.identityId, saved.identityId); assert.equal(retry.identityId, saved.identityId);
  assert.equal(retry.memberId, connected.memberId);
  assert.equal(f.f.store.db.prepare('SELECT count(*) n FROM agent_identities').get().n, before);
  assert.equal(f.f.store.db.prepare("SELECT count(*) n FROM identity_links WHERE room_id='second'").get().n, 1);
  await new RoomClient({ ...retry, apiBase: f.origin }).checkConnection();
  t.diagnostic(JSON.stringify({ scenario: 'existing-principal-second-room', identitiesBefore: before, identitiesAfter: before,
    secondRoomLinks: 1, identityPreserved: true, memberPreservedOnRetry: true }));
});
