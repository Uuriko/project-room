import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { GOOGLE_ISSUER, GOOGLE_SCOPES, GOOGLE_CALLBACK_PATH } from '../server/google-oauth.mjs';
import { STARTER_ROOM_ID } from '../server/provider-onboarding.mjs';
import { providerAccountId } from '../server/operator-account-id.mjs';

const clientId = '1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
const sub = '123456789012345678901';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: 'jwk' });
jwk.kid = 'google-login-kid';
jwk.alg = 'RS256';
jwk.use = 'sig';

function idToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: GOOGLE_ISSUER, sub, aud: clientId, iat: now, exp: now + 600 })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}

test('Google HTTP start redirects to Google; callback joins Welcome without using email as the account id', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'google-login-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const token = idToken();
  const server = createRoomServer({
    store,
    operatorAccountId: 'c6a94a',
    googleAuth: {
      clientId, clientSecret: 'GOCSPX-fixture',
      fetchImpl: async (url) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return Response.json({ id_token: token, token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES });
        }
        if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
        return new Response('missing', { status: 404 });
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(origin + '/api/auth-config')).json();
  assert.equal(config.provider, 'google');
  assert.equal(config.authorizationPath, '/api/auth/google/start');
  assert.equal(Object.hasOwn(config, 'publishableKey'), false);
  const start = await fetch(origin + '/api/auth/google/start', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.origin, 'https://accounts.google.com');
  assert.equal(authorize.searchParams.get('client_id'), clientId);
  assert.equal(authorize.searchParams.get('redirect_uri'), origin + GOOGLE_CALLBACK_PATH);
  const callback = await fetch(`${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get('state')}&code=code-fixture`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), `/?room=${STARTER_ROOM_ID}`);
  const accountId = providerAccountId(GOOGLE_ISSUER, sub);
  assert.equal(store.db.prepare('SELECT id FROM accounts').get().id, accountId);
  assert.doesNotMatch(accountId, /@/);
  const cookie = callback.headers.get('set-cookie').split(';')[0].split('=')[1];
  const joined = store.authenticateAccountSession(cookie, STARTER_ROOM_ID);
  assert.deepEqual(joined.member.permissions, ['manage_members']);
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /Continue with Google/);
  assert.match(app, /authorizationPath === '\/api\/auth\/google\/start'/);
});

test('Google callback failure returns to the room without provisioning an account', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'google-login-fail-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const server = createRoomServer({
    store,
    googleAuth: { clientId, clientSecret: 'GOCSPX-fixture', fetchImpl: async () => new Response('no', { status: 500 }) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(origin + '/api/auth/google/start', { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location'));
  const callback = await fetch(`${origin}${GOOGLE_CALLBACK_PATH}?state=${authorize.searchParams.get('state')}&error=access_denied`, { redirect: 'manual' });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/?google=error');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
});
