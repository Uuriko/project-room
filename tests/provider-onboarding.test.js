import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { loginWithProvider, refreshWithProvider, STARTER_ROOM_ID } from '../server/provider-onboarding.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'provider-onboarding-')), store = new RoomStore(join(directory, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = 'https://test.clerk.accounts.dev', slot = store.createAccountSessionSlot();
  const claims = { iss: issuer, sub: 'user_alice', sid: 'sess_a', exp: Math.floor(store.now() / 1000) + 60 };
  const options = { issuer, token: 'signed-test-assertion', verify: async () => claims, slotToken: slot.token, expectedRevision: 0 };
  return { store, claims, options, slot };
}

test('provider renewal preserves identity and drafts binding without extending another browser', async t => {
  const f = fixture(t), first = await loginWithProvider(f.store, f.options);
  const otherSlot = f.store.createAccountSessionSlot();
  const other = await loginWithProvider(f.store, { ...f.options, slotToken: otherSlot.token });
  const oldExpiry = first.session.expiresAt;
  f.claims.exp += 60;
  const renewed = await refreshWithProvider(f.store, { ...f.options, binding: first.session.sessionBinding });
  assert.equal(renewed.expiresAt, oldExpiry + 60000);
  for (const field of ['sessionBinding', 'sessionRevision', 'csrf']) assert.equal(renewed[field], first.session[field]);
  assert.equal(f.store.authenticateAccountSession(otherSlot.token).expiresAt, other.session.expiresAt);
  f.claims.exp -= 60;
  assert.equal((await refreshWithProvider(f.store, { ...f.options, binding: renewed.sessionBinding })).expiresAt, renewed.expiresAt);
  assert.equal(f.store.room(first.roomId).sequence, 3);
});

test('provider renewal rejects changed identity, logout, stale binding and expired sessions', async t => {
  for (const scenario of ['identity', 'logout', 'binding', 'expired', 'revoked']) {
    const f = fixture(t), first = await loginWithProvider(f.store, f.options);
    let binding = first.session.sessionBinding;
    if (scenario === 'identity') f.claims.sub = 'user_other';
    if (scenario === 'logout') f.store.logoutAccountSession(f.slot.token, 1);
    if (scenario === 'binding') binding = 'wrong';
    if (scenario === 'expired') { const later = first.session.expiresAt + 1; f.store.now = () => later; f.claims.exp += 120; }
    if (scenario === 'revoked') f.store.changeAccountAccess(first.session.account.id, { expectedRevision: 0, active: false, reason: 'test' });
    const before = f.store.db.prepare('SELECT count(*) AS n FROM account_credentials').get().n;
    await assert.rejects(refreshWithProvider(f.store, { ...f.options, binding }), undefined, scenario);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM account_credentials').get().n, before);
  }
});

test('renewal rejects malformed and non-HTTPS issuer configuration before verification', async t => {
  const f = fixture(t);
  for (const issuer of ['http://clerk.example.com', 'invalid', 'https://clerk.example.com/path', null]) {
    let called = false;
    await assert.rejects(refreshWithProvider(f.store, { ...f.options, issuer,
      verify: async () => { called = true; return f.claims; } }), { code: 'invalid_provider_login' });
    assert.equal(called, false);
  }
});

test('renewal reclaims expired unreferenced credentials, not credentials of other slots', async t => {
  const f = fixture(t), first = await loginWithProvider(f.store, f.options);
  const start = f.store.now(); let now = start;
  f.store.now = () => now;
  for (let i = 0; i < 20; i++) {
    now += 30000; f.claims.exp = Math.floor(now / 1000) + 60;
    await refreshWithProvider(f.store, { ...f.options, binding: first.session.sessionBinding });
  }
  assert.ok(f.store.db.prepare('SELECT count(*) AS n FROM account_credentials').get().n <= 3);
});

test('verified first sign-in joins Welcome without elevated permissions, repeated sign-in reuses membership', async t => {
  const f = fixture(t), first = await loginWithProvider(f.store, f.options);
  assert.equal(first.roomId, STARTER_ROOM_ID);
  assert.equal(f.store.room(first.roomId).state.room.title, 'Welcome');
  const auth = f.store.authenticateAccountSession(f.slot.token, first.roomId);
  assert.notEqual(auth.member.id, f.store.room(first.roomId).state.room.ownerId);
  assert.deepEqual(auth.member.permissions, []);
  const sequence = f.store.room(first.roomId).sequence;
  const next = await loginWithProvider(f.store, { ...f.options, expectedRevision: 1 });
  assert.equal(next.roomId, first.roomId); assert.equal(next.session.account.id, first.session.account.id);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rooms').get().n, 1);
  assert.equal(f.store.room(first.roomId).sequence, sequence);
  assert.equal(next.session.expiresAt <= f.claims.exp * 1000, true);
});

test('different subjects never link through a matching email', async t => {
  const f = fixture(t); f.claims.email = 'same@example.com';
  const first = await loginWithProvider(f.store, f.options);
  f.claims.sub = 'user_bob';
  const second = await loginWithProvider(f.store, { ...f.options, expectedRevision: 1 });
  assert.equal(first.roomId, second.roomId); assert.notEqual(first.session.account.id, second.session.account.id);
  assert.equal(Object.keys(f.store.room(first.roomId).state.members).length, 3);
});

test('stale browser or invalid assertion does not provision accounts or rooms', async t => {
  for (const patch of [{ expectedRevision: 2 }, { verify: async () => ({ iss: 'other' }) }, { verify: async () => { throw Error('signature'); } }]) {
    const f = fixture(t);
    await assert.rejects(loginWithProvider(f.store, { ...f.options, ...patch }));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rooms').get().n, 0);
  }
});

test('revoked account cannot be revived through provider sign-in', async t => {
  const f = fixture(t), first = await loginWithProvider(f.store, f.options);
  f.store.changeAccountAccess(first.session.account.id, { expectedRevision: 0, active: false, reason: 'test' });
  const revision = f.store.accountSessionSlot(f.slot.token).sessionRevision;
  await assert.rejects(loginWithProvider(f.store, { ...f.options, expectedRevision: revision }), /Sign-in/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rooms').get().n, 1);
});

test('HTTP provider exchange requires browser CSRF and a signed identity, then opens only its starter room', async t => {
  const f = fixture(t), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const server = createRoomServer({ store: f.store, providerAuth: { issuer: f.options.issuer,
    publishableKey: 'pk_test_' + Buffer.from('test.clerk.accounts.dev$').toString('base64'),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), authorizedParties: ['http://localhost:3000'] } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configResponse = await fetch(origin + '/api/auth-config');
  const config = await configResponse.json();
  assert.deepEqual(Object.keys(config).sort(), ['issuer', 'provider', 'publishableKey']);
  assert.equal(config.provider, 'clerk'); assert.equal(config.issuer, f.options.issuer);
  assert.match(configResponse.headers.get('cache-control'), /no-store/);
  assert.equal(await (await fetch(origin + '/api/auth-config', { method: 'HEAD' })).text(), '');
  const bootstrap = await fetch(origin + '/api/account-session'), cookie = bootstrap.headers.get('set-cookie').split(';')[0], slot = await bootstrap.json();
  const now = Math.floor(f.store.now() / 1000);
  const input = [{ alg: 'RS256', typ: 'JWT' }, { ...f.claims, azp: 'http://localhost:3000', iat: now, nbf: now }].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const token = input + '.' + sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
  const options = { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, expectedSessionRevision: slot.sessionRevision }) };
  assert.equal((await fetch(origin + '/api/provider-session', options)).status, 403);
  const response = await fetch(origin + '/api/provider-session', { ...options, headers: { ...options.headers, 'X-CSRF-Token': slot.csrf } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  assert.equal(result.starterRoomId, STARTER_ROOM_ID);
  assert.deepEqual(f.store.authenticateAccountSession(cookie.split('=')[1], result.starterRoomId).member.permissions, []);
  assert.equal(JSON.stringify(result).includes(token), false);
  const refreshOptions = { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json',
    'X-Session-Binding': result.sessionBinding }, body: JSON.stringify({ token }) };
  assert.equal((await fetch(origin + '/api/provider-session/refresh', refreshOptions)).status, 403);
  const refreshed = await fetch(origin + '/api/provider-session/refresh', { ...refreshOptions,
    headers: { ...refreshOptions.headers, 'X-CSRF-Token': result.csrf } });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const renewed = await refreshed.json();
  assert.equal(renewed.sessionBinding, result.sessionBinding);
  assert.equal(renewed.sessionRevision, result.sessionRevision);
  assert.equal(JSON.stringify(renewed).includes(token), false);
});

test('an unrelated Welcome room cannot be opened through onboarding', async t => {
  const f = fixture(t);
  f.store.initialize(initialRoom(STARTER_ROOM_ID));
  await assert.rejects(loginWithProvider(f.store, f.options), { code: 'provider_room_conflict' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
  assert.equal(f.store.room(STARTER_ROOM_ID).sequence, 2);
});

test('shared members can chat but cannot grant authority; removed members stay removed', async t => {
  const f = fixture(t), first = await loginWithProvider(f.store, f.options);
  const member = f.store.authenticateAccountSession(f.slot.token, first.roomId).member;
  const key = f.store.issueAccessKey(first.roomId, member.id);
  f.store.command(key, first.roomId, { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'hello', body: 'Hello everyone' } });
  assert.throws(() => f.store.command(key, first.roomId, { id: crypto.randomUUID(), type: 'member.added',
    data: { memberId: 'takeover', displayName: 'Agent', kind: 'agent', permissions: ['manage_members'] } }));
  f.claims.sub = 'user_bob';
  const second = await loginWithProvider(f.store, { ...f.options, expectedRevision: 1 });
  assert.equal(f.store.room(second.roomId).state.messages.at(-1).body, 'Hello everyone');
  // An operator-issued host key is test-only; onboarding never issues one.
  const hostKey = f.store.issueAccessKey(first.roomId, 'welcome-host');
  f.store.command(hostKey, first.roomId, { id: crypto.randomUUID(), type: 'member.access_changed',
    data: { memberId: member.id, expectedMemberRevision: 0, permissions: [], active: false } });
  f.claims.sub = 'user_alice';
  await assert.rejects(loginWithProvider(f.store, { ...f.options, expectedRevision: 2 }), { code: 'provider_room_unavailable' });
});

test('previous private starter rooms remain private and reusable', async t => {
  const f = fixture(t);
  const digest = createHash('sha256').update(JSON.stringify([f.options.issuer, f.claims.sub])).digest('hex');
  const provenance = `clerk:${createHash('sha256').update(f.options.issuer).digest('hex')}`;
  f.store.createAccount(`idp-${digest}`, provenance);
  f.store.initialize(initialRoom(`room-${digest}`));
  f.store.ensureHumanAccountBinding(`room-${digest}`, 'owner', `idp-${digest}`, provenance);
  const first = await loginWithProvider(f.store, f.options);
  assert.equal(first.roomId, `room-${digest}`);
  f.claims.sub = 'user_bob';
  const second = await loginWithProvider(f.store, { ...f.options, expectedRevision: 1 });
  assert.equal(second.roomId, STARTER_ROOM_ID);
  assert.throws(() => f.store.authenticateAccountSession(f.slot.token, first.roomId));
});
