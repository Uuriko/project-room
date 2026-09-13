import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { loginWithProvider } from '../server/provider-onboarding.mjs';
import { createRoomServer } from '../server/http.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'provider-onboarding-')), store = new RoomStore(join(directory, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = 'https://test.clerk.accounts.dev', slot = store.createAccountSessionSlot();
  const claims = { iss: issuer, sub: 'user_alice', sid: 'sess_a', exp: Math.floor(store.now() / 1000) + 60 };
  const options = { issuer, token: 'signed-test-assertion', verify: async () => claims, slotToken: slot.token, expectedRevision: 0 };
  return { store, claims, options, slot };
}

test('verified first sign-in atomically creates a private starter room, repeated sign-in reuses it', async t => {
  const f = fixture(t), first = await loginWithProvider(f.store, f.options);
  assert.equal(f.store.room(first.roomId).state.room.title, 'My room');
  assert.deepEqual(Object.keys(f.store.room(first.roomId).state.members), ['owner']);
  const next = await loginWithProvider(f.store, { ...f.options, expectedRevision: 1 });
  assert.equal(next.roomId, first.roomId); assert.equal(next.session.account.id, first.session.account.id);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rooms').get().n, 1);
  assert.equal(next.session.expiresAt <= f.claims.exp * 1000, true);
});

test('different subjects never link through a matching email', async t => {
  const f = fixture(t); f.claims.email = 'same@example.com';
  const first = await loginWithProvider(f.store, f.options);
  f.claims.sub = 'user_bob';
  const second = await loginWithProvider(f.store, { ...f.options, expectedRevision: 1 });
  assert.notEqual(first.roomId, second.roomId); assert.notEqual(first.session.account.id, second.session.account.id);
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
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), authorizedParties: ['http://localhost:3000'] } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(origin + '/api/account-session'), cookie = bootstrap.headers.get('set-cookie').split(';')[0], slot = await bootstrap.json();
  const now = Math.floor(f.store.now() / 1000);
  const input = [{ alg: 'RS256', typ: 'JWT' }, { ...f.claims, azp: 'http://localhost:3000', iat: now, nbf: now }].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const token = input + '.' + sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
  const options = { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ token, expectedSessionRevision: slot.sessionRevision }) };
  assert.equal((await fetch(origin + '/api/provider-session', options)).status, 403);
  const response = await fetch(origin + '/api/provider-session', { ...options, headers: { ...options.headers, 'X-CSRF-Token': slot.csrf } });
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json();
  assert.ok(result.starterRoomId.startsWith('room-'));
  assert.equal(f.store.authenticateAccountSession(cookie.split('=')[1], result.starterRoomId).member.id, 'owner');
  assert.equal(JSON.stringify(result).includes(token), false);
});
