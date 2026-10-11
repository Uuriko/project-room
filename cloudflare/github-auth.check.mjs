import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
for (const configured of [false, true]) test(`GitHub public capability and OAuth start use Worker configuration (${configured})`, async () => {
  const bundled = await build({ entryPoints: ['room.mjs'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin, GITHUB_OAUTH_CLIENT_ID: 'fixture-client', ...(configured ? { GITHUB_OAUTH_CLIENT_SECRET: 'fixture-private-secret' } : {}) } });
  try {
    const call = (path, extra = {}) => mf.dispatchFetch(origin + path, { ...extra, headers: { 'CF-Connecting-IP': '192.0.2.1', ...extra.headers } });
    const capability = await call('/api/auth/providers');
    assert.equal(capability.status, 200); assert.match(capability.headers.get('cache-control'), /no-store/);
    assert.equal(capability.headers.get('set-cookie'), null);
    assert.deepEqual(await capability.json(), { providers: { github: { configured } } });
    if (!configured) { assert.equal((await call('/api/auth/github/start')).status, 503); return; }
    const slotResponse = await call('/api/account-session'), slot = await slotResponse.json();
    const cookie = slotResponse.headers.get('set-cookie').split(';')[0];
    const start = await call('/api/auth/github/start', { redirect: 'manual', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': slot.csrf } });
    assert.equal(start.status, 302, await start.clone().text());
    const url = new URL(start.headers.get('location'));
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/auth/github/callback');
    assert.equal(url.searchParams.get('scope'), 'read:user user:email');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.href.includes('fixture-private-secret'), false);
  } finally { await mf.dispose(); }
});
