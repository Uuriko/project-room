import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

for (const legacy of [false, true]) test(`configured Google sign-in starts on Workers (legacy schema: ${legacy})`, async () => {
 const bundled = await build({ entryPoints: ['google-auth.test-fixture.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
 const origin = 'https://room.example.test';
 const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'GoogleTestRoom', useSQLite: true } }, bindings: { LEGACY_OAUTH_SCHEMA: legacy, ROOM_ORIGIN: origin, ROOM_GOOGLE_CLIENT_ID: '123-example.apps.googleusercontent.com', ROOM_GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret' } });
 try {
  const res = await mf.dispatchFetch(origin + '/api/auth/google/start', { redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  assert.equal(res.status, 302, await res.clone().text());
  const url = new URL(res.headers.get('Location'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/auth/google/callback');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(res.headers.get('Set-Cookie'), /HttpOnly/);
 } finally { await mf.dispose(); }
});
