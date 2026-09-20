import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

for (const legacy of [false, true]) test(`configured Google sign-in starts on Workers (legacy schema: ${legacy})`, async () => {
 const bundled = await build({ entryPoints: ['google-auth.test-fixture.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
 const origin = 'https://room.example.test';
 let jwk, token, redirectProvider = false;
 const mf = new Miniflare({ outboundService: async request => {
  if (redirectProvider) return new Response(null, {status: 302, headers: {Location: 'https://untrusted.example/'}});
  if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({keys: [jwk]});
  if (request.url === 'https://oauth2.googleapis.com/token') return Response.json({id_token: token, scope: 'openid email profile'});
  throw new Error('Unexpected provider destination');
 }, modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'GoogleTestRoom', useSQLite: true } }, bindings: { LEGACY_OAUTH_SCHEMA: legacy, ROOM_ORIGIN: origin, ROOM_GOOGLE_CLIENT_ID: '123-example.apps.googleusercontent.com', ROOM_GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret' } });
 try {
  const res = await mf.dispatchFetch(origin + '/api/auth/google/start', { redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  assert.equal(res.status, 302, await res.clone().text());
  const url = new URL(res.headers.get('Location'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/auth/google/callback');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(res.headers.get('Set-Cookie'), /HttpOnly/);
  const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
  jwk = {...keys.publicKey.export({format: 'jwk'}), kid: 'fixture', alg: 'RS256', use: 'sig'};
  const now = Math.floor(Date.now()/1000);
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const input = encode({alg: 'RS256', kid: 'fixture'}) + '.' + encode({iss: 'https://accounts.google.com', aud: '123-example.apps.googleusercontent.com', sub: '123456789', iat: now, exp: now+3600});
  token = input + '.' + sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
  const callback = state => mf.dispatchFetch(origin + '/api/auth/google/callback?state=' + state + '&code=synthetic-code', {redirect: 'manual', headers: {'CF-Connecting-IP': '192.0.2.1'}});
  const completed = await callback(url.searchParams.get('state'));
  assert.equal(completed.headers.get('X-Room-Auth-Failure'), null);
  assert.match(await completed.text(), /account=1/);
  const cookie = completed.headers.get('Set-Cookie').split(';')[0];
  const session = await mf.dispatchFetch(origin + '/api/account-session', {headers: {'CF-Connecting-IP': '192.0.2.1', Cookie: cookie}});
  assert.equal(session.status, 200);
  assert.equal((await session.json()).authenticated, true);
  redirectProvider = true;
  const retry = await mf.dispatchFetch(origin + '/api/auth/google/start', {redirect: 'manual', headers: {'CF-Connecting-IP': '192.0.2.1'}});
  const rejected = await callback(new URL(retry.headers.get('Location')).searchParams.get('state'));
  assert.equal(rejected.headers.get('X-Room-Auth-Failure'), 'google_provider_rejected');
 } finally { await mf.dispose(); }
});
