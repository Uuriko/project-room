import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { RoomStore } from '../../server/store.mjs';
import { initialRoom } from '../../server/bootstrap.mjs';
import { event } from '../../src/events.js';
import { createOAuthProvider } from '../../server/oauth-provider.mjs';
import { validateMcpOAuthBinding, mcpOAuthIdentityEpoch, resolveMcpOAuthPrincipal,
  mcpOAuthPrincipalDescriptor, authorizeMcpOAuthDescriptor } from '../../server/mcp-oauth.mjs';
export const resource = 'https://room.example/mcp';
const client = { clientId: 'binding-context-test', name: 'Binding context test', redirectUris: ['https://client.example/callback'] };
const verifier = 'v'.repeat(43);
export function bindingFixture(t, retained = 12, { canonical = true } = {}) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  const history = initialRoom();
  for (let i = 0; i < retained; i++) history.push(event({ id: `history-${i}`, type: 'message.posted',
    roomId: 'commons', actorId: 'owner', at: '2026-11-01T12:00:00.000Z',
    data: { messageId: `history-${i}`, body: `Retained ${i}: ${'x'.repeat(64)}` } }));
  store.initialize(history);
  const ownerKey = store.issueAccessKey('commons', 'owner'), session = store.createSession(ownerKey);
  const accountId = store.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='commons' AND member_id='owner'").get().account_id;
  const identity = store.identities.create('Binding Agent');
  const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
  store.agentConnections.apply(session.token, 'commons', { action: 'create', requestId: randomUUID(), memberId: 'binding-agent',
    displayName: 'Binding Agent', access: 'collaborate', expectedOwnerRevision: 0, expiresAt: store.now() + 3600000,
    keyHash: createHash('sha256').update(randomUUID()).digest('hex'), identityId: identity.identityId, identityLinkCode: linkCode }, session.session.sessionBinding);
  if (canonical) {
    while (!store.backfillMessages({ limit: 1000 }).done) {}
    assert.equal(store.checkMessagesParity({ roomId: 'commons' }).ok, true); store.migrateMessageAuthority('commons');
  }
  const clock = store.now(); store.now = () => clock;
  const binding = { resource, roomId: 'commons', memberId: 'binding-agent', identityId: identity.identityId,
    humanMemberId: 'owner', identityEpoch: mcpOAuthIdentityEpoch(store, identity.identityId) };
  const provider = createOAuthProvider({ db: store.db, clock: () => store.now(),
    isAccountActive: id => store.db.prepare('SELECT active FROM accounts WHERE id=?').get(id)?.active === 1,
    isBindingActive: (id, value) => Boolean(validateMcpOAuthBinding(store, id, value)) });
  provider.registerClient(client);
  const code = provider.issueCode({ clientId: client.clientId, userId: accountId, redirectUri: client.redirectUris[0], scopes: ['rooms:read','chat:read'],
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'), binding }).code;
  const tokens = provider.exchangeCode({ code, clientId: client.clientId, redirectUri: client.redirectUris[0], codeVerifier: verifier, resource });
  const resolve = (extra = {}) => resolveMcpOAuthPrincipal({ store, provider, token: tokens.accessToken, resource,
    roomId: 'commons', requiredScopes: ['rooms:read'], ...extra });
  const principal = resolve(); assert.equal(principal.memberId, 'binding-agent');
  const descriptor = mcpOAuthPrincipalDescriptor(principal);
  const authorize = () => authorizeMcpOAuthDescriptor({ store, accountProvider: provider, resource, descriptor });
  return { store, accountId, identity, binding, provider, tokens, resolve, authorize, descriptor,
    refresh: () => provider.refresh({ refreshToken: tokens.refreshToken, clientId: client.clientId, resource }) };
}
export function measureBinding(f, operation) {
  const original = f.store.db.prepare, room = f.store.room;
  const result = { fullRoomReads: 0, messageRows: 0, messageBytes: 0, contextRows: 0, contextBytes: 0 };
  f.store._dropProjectionCache();
  for (const key of ['_roomSequenceStmt','_roomProjectionStmt','_roomAuthorityPrefixStmt','_roomAuthorityFullStmt']) f.store[key] = null;
  f.store.room = function(...args) { result.fullRoomReads++; return room.apply(this, args); };
  f.store.db.prepare = function(sql) {
    const statement = original.call(this, sql);
    if (!/\b(?:FROM|JOIN)\s+(?:rooms|integrity_room_state|messages|work_entities)\b/i.test(sql)) return statement;
    const messages = /\b(?:FROM|JOIN)\s+messages\b/i.test(sql);
    const record = row => { if (row !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(row)); result.contextRows++; result.contextBytes += bytes;
      if (messages) { result.messageRows++; result.messageBytes += bytes; }
    } };
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args) => { const rows = target.all(...args); rows.forEach(record); return rows; };
      if (key === 'get') return (...args) => { const row = target.get(...args); record(row); return row; };
      if (key === 'iterate') return function* (...args) { for (const row of target.iterate(...args)) { record(row); yield row; } };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try { result.value = operation(); } finally { f.store.db.prepare = original; f.store.room = room; }
  return result;
}
