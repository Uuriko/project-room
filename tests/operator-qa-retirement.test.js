import { createMcpEventSubscriptions } from "../server/mcp-event-subscriptions.mjs";
import { createHash } from "node:crypto";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { inviteOAuthDatabase } from "../server/mcp-invite-oauth.mjs";
import { createRoomServer } from "../server/http.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { retireQaRoom } from '../server/operator-qa-retirement.mjs';
const roomId = 'qa-onb-10302113';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-retire-')); const path = join(dir, 'room.sqlite');
  const store = new RoomStore(path); store.initialize(initialRoom(roomId)); store.initialize(initialRoom('other'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const legacy = store.issueAccessKey(roomId, 'owner'); const other = store.issueAccessKey('other', 'owner');
  const identity = store.identities.create('Retirement fixture');
  const key = store.agentPlugin.issueOnboardingMcpToken({ identityId: identity.identityId, roomId, label: 'target' });
  const otherKey = store.agentPlugin.issueOnboardingMcpToken({ identityId: identity.identityId, roomId: 'other', label: 'other' });
  const broad = store.agentPlugin.issueApiKey({ identityId: identity.identityId, scopes: [`mcp:room:${roomId}`, 'mcp:room:other', 'rooms:read'] });
  return { store, path, legacy, other, identity, key, otherKey, broad };
}
test('QA retirement revokes target credentials, archives without deletion, preserves unrelated keys and replays', t => {
  const f = fixture(t), input = { roomId, reason: 'KI-194 disposable QA room cleanup' };
  f.store.command(f.legacy, roomId, { id: 'saved-message', type: 'message.posted', data: { messageId: 'saved-message', body: 'Preserve this record' } });
  const invite = f.store.invites.create(f.legacy, roomId, { profile: 'member' });
  const plan = retireQaRoom(f.store, input);
  assert.equal(plan.counts.roomScopedApiKeys, 1); assert.ok(plan.preservedBroadKeys >= 1);
  const execute = { ...input, planHash: plan.planHash, requestId: 'r'.repeat(57) };
  const result = retireQaRoom(f.store, execute, true); assert.equal(result.archived, true);
  assert.throws(() => f.store.authenticate(f.legacy, roomId));
  assert.equal(f.store.agentPlugin.verifyPresentedApiKey(f.key.credential), null);
  assert.ok(f.store.agentPlugin.verifyPresentedApiKey(f.otherKey.credential));
  assert.ok(f.store.agentPlugin.verifyPresentedApiKey('rak_' + f.broad.secret));
  assert.ok(f.store.identities.resolveGlobalIdentitySecret(f.identity.secret));
  assert.ok(f.store.authenticate(f.other, 'other'));
  assert.equal(f.store.room(roomId).state.messages.length, 1);
  assert.throws(() => f.store.invites.redeem(invite.code, { displayName: 'Late join' }));
  assert.equal(f.store.room(roomId).state.room.archivedById, 'owner');
  assert.equal(retireQaRoom(f.store, execute, true).duplicate, true);
  assert.throws(() => retireQaRoom(f.store, { ...execute, reason: 'Changed reason' }, true), e => e.code === 'idempotency_conflict');
  assert.throws(() => retireQaRoom(f.store, { ...execute, requestId: 'r'.repeat(58) }, true), e => e.code === 'plan_required');
  const reopened = new RoomStore(f.path); t.after(() => reopened.close());
  assert.equal(reopened.agentPlugin.verifyPresentedApiKey(f.key.credential), null);
  assert.ok(reopened.agentPlugin.verifyPresentedApiKey(f.otherKey.credential));
});
test('stale plans and late failure cannot leave SQL or resident keys partially revoked', t => {
  const f = fixture(t), input = { roomId, reason: 'QA cleanup rollback' };
  assert.throws(() => f.store.command('Symbol(operator QA room archive)', roomId, { id: 'forged', type: 'room.archived', data: { reason: 'forged', operator: true } }));
  const plan = retireQaRoom(f.store, input);
  f.store.issueAccessKey(roomId, 'owner');
  assert.throws(() => retireQaRoom(f.store, { ...input, planHash: plan.planHash, requestId: 'stale' }, true), e => e.code === 'plan_changed');
  const fresh = retireQaRoom(f.store, input);
  f.store.db.exec("CREATE TRIGGER fail_retirement_audit BEFORE INSERT ON operator_actions WHEN NEW.action='qa_room_retired' BEGIN SELECT RAISE(ABORT,'injected late failure'); END");
  assert.throws(() => retireQaRoom(f.store, { ...input, planHash: fresh.planHash, requestId: 'rollback' }, true), /injected late failure/);
  assert.ok(f.store.agentPlugin.verifyPresentedApiKey(f.key.credential));
  assert.equal(f.store.room(roomId).state.room.archivedAt, undefined);
  assert.throws(() => retireQaRoom(f.store, { ...input, roomId: 'other' }), e => e.code === 'invalid_retirement');
});

for (const invitation of [false, true]) test(`retirement revokes bound OAuth code/access/refresh only (invitation=${invitation})`, t => {
  const f = fixture(t), resource = 'https://room.example/mcp', verifier = 'a'.repeat(43);
  const provider = createOAuthProvider({ db: invitation ? inviteOAuthDatabase(f.store.db) : f.store.db,
    ...(invitation ? { tokenKind: 'invite' } : {}) });
  provider.registerClient({ clientId: 'test', name: 'Test', redirectUris: ['https://client.example/callback'] });
  const mint = target => {
    const binding = { resource, roomId: target, identityId: 'agent', memberId: 'agent', identityEpoch: 'epoch',
      ...(invitation ? { principalType: 'invited-agent', invitationGrantId: 'grant' } : { humanMemberId: 'human' }) };
    const args = { clientId: 'test', userId: 'user', redirectUri: 'https://client.example/callback', scopes: ['chat:read'],
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), binding };
    const code = provider.issueCode(args).code;
    const tokens = provider.exchangeCode({ code, clientId: 'test', redirectUri: args.redirectUri, codeVerifier: verifier, resource });
    return { tokens, unused: provider.issueCode(args).code, args };
  };
  const target = mint(roomId), other = mint('other');
  const input = { roomId, reason: 'OAuth retirement' }; const plan = retireQaRoom(f.store, input);
  retireQaRoom(f.store, { ...input, planHash: plan.planHash, requestId: 'oauth' }, true);
  assert.equal(provider.verifyAccessToken(target.tokens.accessToken, { resource }), null);
  assert.ok(provider.verifyAccessToken(other.tokens.accessToken, { resource }));
  assert.throws(() => provider.refresh({ refreshToken: target.tokens.refreshToken, clientId: 'test', resource }));
  assert.throws(() => provider.exchangeCode({ code: target.unused, clientId: 'test', redirectUri: target.args.redirectUri, codeVerifier: verifier, resource }));
  assert.ok(provider.refresh({ refreshToken: other.tokens.refreshToken, clientId: 'test', resource }).accessToken);
});
test('operator HTTP gate refuses room bearer and requires exact QA scope and plan', async t => {
  const f = fixture(t), operator = 'qa-retirement-operator-fixture-0123456789';
  const prior = process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash('sha256').update(operator).digest('hex');
  t.after(() => { if (prior === undefined) delete process.env.ROOM_OPERATOR_TOKEN_SHA256; else process.env.ROOM_OPERATOR_TOKEN_SHA256 = prior; });
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = (action, authorization, input) => fetch(`http://127.0.0.1:${server.address().port}/api/operator/qa-retirement/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(input) });
  const input = { roomId, reason: 'HTTP qualification' };
  assert.equal((await post('plan', 'Bearer ' + f.legacy, input)).status, 404);
  assert.equal((await post('plan', 'Operator ' + operator, { ...input, roomId: 'other' })).status, 422);
  const response = await post('plan', 'Operator ' + operator, input); assert.equal(response.status, 200);
  const plan = await response.json();
  for (const secret of [f.legacy, f.identity.secret, f.key.credential]) assert.equal(JSON.stringify(plan).includes(secret), false);
  assert.equal((await post('execute', 'Operator ' + operator, { ...input, planHash: plan.planHash, requestId: 'http' })).status, 200);
});

test('retirement fences target native leases and signing keys without touching another room subscription', async t => {
  const f = fixture(t), delivered = [];
  const manager = createMcpEventSubscriptions({ store: f.store, authorize: async () => true,
    dnsResolvers: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] },
    transport: async (_url, _addresses, request) => {
      const body = JSON.parse(request.body);
      if (body.type === 'verification') return { status: 200, text: async () => JSON.stringify({ challenge: body.challenge }) };
      delivered.push(body); return { status: 200, text: async () => '{}' };
    } });
  const subscribe = target => manager.subscribe({ principal: { principalType: 'invited-agent', familyId: target,
    resource: 'https://room.example/mcp', roomId: target, memberId: 'agent', identityId: 'agent', scopes: ['chat:read'] },
    name: 'room.requested', arguments: { roomId: target, memberId: 'agent' },
    delivery: { mode: 'webhook', url: 'https://callback.example/events', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` } });
  const target = await subscribe(roomId), other = await subscribe('other');
  for (const room of [roomId, 'other']) assert.equal(manager.enqueueRequested({ roomId: room, memberId: 'agent', eventId: 'event1' }), 1);
  f.store.db.prepare("UPDATE mcp_event_outbox SET state='leased',lease='old-lease',lease_until=? WHERE subscription_id=?").run(f.store.now() + 30000, target.id);
  const row = id => f.store.db.prepare('SELECT * FROM mcp_event_subscriptions WHERE id=?').get(id);
  const beforeTarget = row(target.id), beforeOther = row(other.id);
  const input = { roomId, reason: 'Native retirement' }, plan = retireQaRoom(f.store, input);
  assert.equal(plan.counts.nativeSubscriptions, 1); assert.equal(plan.counts.nativeOutbox, 1);
  retireQaRoom(f.store, { ...input, planHash: plan.planHash, requestId: 'native' }, true);
  assert.equal(row(target.id).state, 'inactive'); assert.equal(row(target.id).document, '{}');
  assert.notEqual(row(target.id).generation, beforeTarget.generation);
  assert.deepEqual(row(other.id), beforeOther);
  const outbox = f.store.db.prepare('SELECT state,lease,lease_until FROM mcp_event_outbox WHERE subscription_id=?').get(target.id);
  assert.deepEqual({ ...outbox }, { state: 'dead', lease: null, lease_until: null });
  assert.equal(f.store.db.prepare("UPDATE mcp_event_outbox SET state='delivered' WHERE subscription_id=? AND lease='old-lease'").run(target.id).changes, 0);
  await manager.drain(); assert.deepEqual(delivered.map(event => event.data.roomId), ['other']);
  assert.equal(manager.enqueueRequested({ roomId, memberId: 'agent', eventId: 'event2' }), 0);
});
