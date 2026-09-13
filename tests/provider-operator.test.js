import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { loginWithProvider, STARTER_ROOM_ID } from '../server/provider-onboarding.mjs';
import { createRoomServer } from '../server/http.mjs';

function fixture(t, sub = 'user_alice') {
  const directory = mkdtempSync(join(tmpdir(), 'operator-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = 'https://test.clerk.accounts.dev';
  const slot = store.createAccountSessionSlot();
  const claims = { iss: issuer, sub, sid: 'sess_a', exp: Math.floor(store.now() / 1000) + 120 };
  const accountId = `idp-${createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex')}`;
  return {
    store, accountId, options: {
      issuer, token: 'signed-test-assertion', verify: async () => claims, slotToken: slot.token, expectedRevision: 0
    }
  };
}

test('named operator gets manage_members on Welcome; others stay empty', async t => {
  const op = fixture(t, 'user_alice');
  const first = await loginWithProvider(op.store, { ...op.options, operatorAccountId: op.accountId });
  assert.equal(first.roomId, STARTER_ROOM_ID);
  const memberId = Object.keys(op.store.room(STARTER_ROOM_ID).state.members).find(id => id.startsWith('member-'));
  assert.deepEqual(op.store.room(STARTER_ROOM_ID).state.members[memberId].permissions, ['manage_members']);
  assert.equal(op.store.room(STARTER_ROOM_ID).state.room.ownerId, 'welcome-host');
  const other = fixture(t, 'user_bob');
  await loginWithProvider(other.store, { ...other.options, operatorAccountId: op.accountId });
  const bob = Object.keys(other.store.room(STARTER_ROOM_ID).state.members).find(id => id.startsWith('member-'));
  assert.deepEqual(other.store.room(STARTER_ROOM_ID).state.members[bob].permissions, []);
});

test('HTTP provider login promotes operator on Welcome', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'operator-http-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const issuer = 'https://test.clerk.accounts.dev';
  const sub = 'user_alice';
  const operatorAccountId = `idp-${createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex')}`;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const server = createRoomServer({
    store, operatorAccountId,
    providerAuth: {
      issuer, publishableKey: 'pk_test_' + Buffer.from('test.clerk.accounts.dev$').toString('base64'),
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), authorizedParties: ['http://localhost:3000']
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(origin + '/api/account-session');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const slot = await bootstrap.json();
  const now = Math.floor(store.now() / 1000);
  const input = [{ alg: 'RS256', typ: 'JWT' }, { iss: issuer, sub, sid: 'sess_a', azp: 'http://localhost:3000', iat: now, nbf: now, exp: now + 120 }].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const token = input + '.' + sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
  const res = await fetch(origin + '/api/provider-session', {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': slot.csrf },
    body: JSON.stringify({ token, expectedSessionRevision: slot.sessionRevision })
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  const member = store.authenticateAccountSession(cookie.split('=')[1], body.starterRoomId).member;
  assert.deepEqual(member.permissions, ['manage_members']);
});
