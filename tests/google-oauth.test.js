import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  GoogleSignIn, googleConfig, googleSubject, googlePostLoginPage, GOOGLE_ISSUER, GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH, GOOGLE_SCOPES
} from '../server/google-oauth.mjs';

const clientId = '1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
const redirectUri = `http://127.0.0.1:4173${GOOGLE_CALLBACK_PATH}`;
const slotToken = 'a'.repeat(43);
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = keys.publicKey.export({ format: 'jwk' });
jwk.kid = 'google-test-kid';
jwk.use = 'sig';
jwk.alg = 'RS256';

function idToken({ sub = '123456789012345678901', expOffset = 600, aud = clientId, iss = GOOGLE_ISSUER } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss, sub, aud, iat: now, exp: now + expOffset })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
}

function fixture(responder) {
  let now = Date.now();
  const calls = [];
  const token = idToken();
  const grant = { id_token: token, token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES };
  const oauth = new GoogleSignIn({
    clientId, clientSecret: 'GOCSPX-fixture-secret', redirectUri, now: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (responder) return responder(url, init, calls.length);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json(grant);
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
      return new Response('missing', { status: 404 });
    }
  });
  const begin = () => new URL(oauth.begin({ slotToken, expectedRevision: 0 }).authorizationUrl);
  const callback = auth => `${redirectUri}?state=${auth.searchParams.get('state')}&code=code-fixture`;
  return { oauth, calls, begin, callback, token, advance: ms => { now += ms; } };
}

test('googleConfig is opt-in and refuses partial or non-HTTPS production origins', () => {
  assert.equal(googleConfig({}, 'https://room.trydemigod.com'), null);
  assert.throws(() => googleConfig({ ROOM_GOOGLE_CLIENT_ID: clientId }, 'https://room.trydemigod.com'));
  assert.throws(() => googleConfig({ ROOM_GOOGLE_CLIENT_ID: clientId, ROOM_GOOGLE_CLIENT_SECRET: 'secret' }, 'http://room.trydemigod.com'));
  const config = googleConfig({ ROOM_GOOGLE_CLIENT_ID: clientId, ROOM_GOOGLE_CLIENT_SECRET: 'GOCSPX-secret' }, 'https://room.trydemigod.com');
  assert.equal(config.issuer, GOOGLE_ISSUER);
  assert.equal(config.redirectUri, `https://room.trydemigod.com${GOOGLE_CALLBACK_PATH}`);
  assert.equal(googleSubject('1234567890'), true);
  assert.equal(googleSubject('user_alice'), false);
  assert.equal(googleSubject('0'), false);
});

test('begin requests OpenID consent with PKCE and never puts the client secret in the URL', () => {
  const f = fixture();
  const auth = f.begin();
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.pathname, '/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('scope'), GOOGLE_SCOPES);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('include_granted_scopes'), 'false');
  assert.ok(!auth.href.includes('GOCSPX'));
  assert.equal(auth.searchParams.get('redirect_uri'), redirectUri);
});

test('complete exchanges the code, verifies the ID token, and returns the slot without using email as an account key', async () => {
  const f = fixture();
  const auth = f.begin();
  const result = await f.oauth.complete({ callbackUrl: f.callback(auth) });
  assert.equal(result.slotToken, slotToken);
  assert.equal(result.expectedRevision, 0);
  assert.equal(result.claims.iss, GOOGLE_ISSUER);
  assert.equal(result.claims.sub, '123456789012345678901');
  assert.equal(Object.hasOwn(result.claims, 'email'), false);
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(f.calls[0].init.body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(f.calls[1].url, 'https://www.googleapis.com/oauth2/v3/certs');
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(auth) }), { code: 'google_state_invalid' });
});

test('state expiry, consent denial, and foreign callbacks never hit the token endpoint', async () => {
  const f = fixture();
  const old = f.begin();
  const current = f.begin();
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(old) }), { code: 'google_state_invalid' });
  await assert.rejects(f.oauth.complete({ callbackUrl: `${f.callback(current)}&error=access_denied` }), { code: 'google_consent_denied' });
  const next = f.begin();
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(next).replace('127.0.0.1', 'evil.example') }), { code: 'google_callback_invalid' });
  f.advance(600000);
  const late = f.begin();
  f.advance(600000);
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(late) }), { code: 'google_state_invalid' });
  assert.equal(f.calls.length, 0);
});

test('rejects tokens that omit openid or fail audience/subject checks', async () => {
  const badAud = idToken({ aud: 'other.apps.googleusercontent.com' });
  const f = fixture((url) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: badAud, token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES });
    return Response.json({ keys: [jwk] });
  });
  const auth = f.begin();
  await assert.rejects(f.oauth.complete({ callbackUrl: f.callback(auth) }), { code: 'google_token_invalid' });
  const missingOpenId = fixture((url) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: idToken(), token_type: 'Bearer', expires_in: 3600, scope: 'email' });
    return Response.json({ keys: [jwk] });
  });
  const auth2 = missingOpenId.begin();
  await assert.rejects(missingOpenId.oauth.complete({ callbackUrl: missingOpenId.callback(auth2) }), { code: 'google_scope_mismatch' });
});

test('start and callback paths are stable public routes', () => {
  assert.equal(GOOGLE_START_PATH, '/api/auth/google/start');
  assert.equal(GOOGLE_CALLBACK_PATH, '/api/auth/google/callback');
});

test('googlePostLoginPage only returns same-origin room or error paths', () => {
  assert.match(googlePostLoginPage('/?room=welcome'), /url=\/\?room=welcome/);
  assert.match(googlePostLoginPage('/?google=error'), /url=\/\?google=error/);
  assert.throws(() => googlePostLoginPage('https://evil.example/'), { code: 'google_callback_invalid' });
  assert.throws(() => googlePostLoginPage('/?room=welcome&next=https://evil.example'), { code: 'google_callback_invalid' });
});
