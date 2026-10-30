import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOAuthProvider } from '../server/oauth-provider.mjs';
import { mcpOAuthResourceMetadata, mcpOAuthChallenge, resolveMcpOAuthPrincipal } from '../server/mcp-oauth.mjs';
const resource = 'https://room.example/mcp';
const binding = { resource, roomId: 'room', identityId: 'agent', memberId: 'agent', humanMemberId: 'friend' };
const verifier = 'v'.repeat(43);
const request = { clientId: 'test', userId: 'account', redirectUri: 'https://client.example/callback',
  scopes: ['chat:read'], codeChallenge: createHash('sha256').update(verifier).digest('base64url') };
function setup(durable = false) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id TEXT,active INTEGER); INSERT INTO accounts VALUES('account',1);
    CREATE TABLE member_accounts(room_id TEXT,member_id TEXT,account_id TEXT); INSERT INTO member_accounts VALUES('room','friend','account');
    CREATE TABLE identity_links(room_id TEXT,identity_id TEXT,member_id TEXT); INSERT INTO identity_links VALUES('room','agent','agent');`);
  const state = { members: { friend: { kind: 'human', active: true }, agent: { kind: 'agent', active: true, identityId: 'agent', accountableHumanId: 'friend' } } };
  const store = { db, room: () => ({ state }) };
  const provider = createOAuthProvider(durable ? { db } : {});
  provider.registerClient({ clientId: request.clientId, name: 'Test', redirectUris: [request.redirectUri] });
  const code = () => provider.issueCode({ ...request, binding }).code;
  const exchange = (value, target = resource) => provider.exchangeCode({ code: value, clientId: request.clientId,
    redirectUri: request.redirectUri, codeVerifier: verifier, resource: target });
  const pair = exchange(code());
  const resolve = (extra = {}) => resolveMcpOAuthPrincipal({ store, provider, token: pair.accessToken, resource, roomId: 'room', requiredScopes: ['chat:read'], ...extra });
  return { db, state, store, provider, code, exchange, pair, resolve };
}
for (const durable of [false, true]) {
  test(`resource and agent binding survive token rotation (${durable ? 'SQLite' : 'Map'})`, () => {
    const f = setup(durable);
    assert.equal(f.resolve().memberId, 'agent');
    assert.equal(f.provider.verifyAccessToken(f.pair.accessToken), null);
    assert.equal(f.resolve({ resource: 'https://evil.example/mcp' }), null);
    assert.equal(f.resolve({ roomId: 'another-room' }), null);
    assert.equal(f.resolve({ requiredScopes: ['chat:write'] }), null);
    const code = f.code();
    assert.throws(() => f.exchange(code, 'https://evil.example/mcp'), /resource/);
    assert.throws(() => f.provider.exchangeCode({ code, clientId: request.clientId, redirectUri: request.redirectUri, codeVerifier: verifier }), /resource/);
    assert.ok(f.exchange(code).accessToken); // rejected exchange did not consume code
    assert.throws(() => f.provider.refresh({ refreshToken: f.pair.refreshToken, clientId: request.clientId }), /resource/);
    const next = f.provider.refresh({ refreshToken: f.pair.refreshToken, clientId: request.clientId, resource });
    assert.deepEqual(f.provider.verifyAccessToken(next.accessToken, { resource }).binding, binding);
    if (durable) {
      const restarted = createOAuthProvider({ db: f.db });
      assert.deepEqual(restarted.verifyAccessToken(next.accessToken, { resource }).binding, binding);
    }
    f.provider.revoke(next.refreshToken);
    assert.equal(f.resolve({ token: next.accessToken }), null);
    f.db.close();
  });
}
for (const [label, mutate] of [
  ['deleted account', f => f.db.exec('UPDATE accounts SET active=0')],
  ['different account', f => f.db.exec("UPDATE member_accounts SET account_id='other'")],
  ['removed human', f => { f.state.members.friend.active = false; }],
  ['removed agent', f => { f.state.members.agent.active = false; }],
  ['different agent owner', f => { f.state.members.agent.accountableHumanId = 'john'; }],
  ['missing accountable human', f => { delete f.state.members.agent.accountableHumanId; }],
  ['changed identity link', f => f.db.exec("UPDATE identity_links SET member_id='other'")],
  ['changed member identity', f => { f.state.members.agent.identityId = 'other'; }],
  ['human masquerading as agent', f => { f.state.members.agent.kind = 'human'; }],
]) test(`existing grant fails after ${label}`, () => {
  const f = setup(true);
  assert.ok(f.resolve());
  mutate(f);
  assert.equal(f.resolve(), null);
  f.db.close();
});
test('legacy account grants cannot be upgraded to an MCP agent grant', () => {
  const f = setup();
  const code = f.provider.issueCode(request).code;
  assert.throws(() => f.exchange(code), /resource/);
  const pair = f.provider.exchangeCode({ code, clientId: request.clientId, redirectUri: request.redirectUri, codeVerifier: verifier });
  assert.ok(f.provider.verifyAccessToken(pair.accessToken));
  assert.equal(f.resolve({ token: pair.accessToken }), null);
  f.db.close();
});
test('incomplete, credentialed and non-HTTPS bindings fail before issuing a code', () => {
  const f = setup();
  for (const bad of [{ resource }, { ...binding, resource: 'http://room.example/mcp' },
    { ...binding, resource: 'https://name:secret@room.example/mcp' },
    { ...binding, resource: resource + '#fragment' }])
    assert.throws(() => f.provider.issueCode({ ...request, binding: bad }));
  f.db.close();
});
test('resource metadata and challenges are explicit and reject header injection', () => {
  assert.equal(mcpOAuthResourceMetadata(resource, 'https://room.example').resource, resource);
  assert.match(mcpOAuthChallenge('https://room.example/.well-known/oauth-protected-resource/mcp')['WWW-Authenticate'], /resource_metadata=/);
  assert.throws(() => mcpOAuthChallenge('https://room.example/\r\nInjected:yes'));
  assert.throws(() => mcpOAuthResourceMetadata('http://room.example/mcp', 'https://room.example'));
});
