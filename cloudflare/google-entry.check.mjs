import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('public entry Google sign-in moves to canonical host before any durable request', async () => {
  const bundled = await build({ stdin: { contents: `
    import worker from './room.mjs';
    export default { async fetch(request, env, ctx) {
      let calls = 0;
      const ROOM = { getByName() { calls++; return { fetch(request) {
        return Response.json({ url: request.url, method: request.method }, { status: 218 });
      } }; } };
      const response = await worker.fetch(request, { ...env, ROOM }, ctx);
      const headers = new Headers(response.headers); headers.set('X-Test-Durable-Calls', String(calls));
      return new Response(response.body, { status: response.status, headers });
    } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], bindings: { ROOM_ORIGIN: origin } });
  const request = (url, method = 'GET') => mf.dispatchFetch(url, { method, redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  try {
    const query = '?returnTo=%2F%3Froom%3Dtest&next=https%3A%2F%2Fevil.example%2F';
    for (const host of ['www.getdasha.com', 'getdasha.com']) {
      const response = await request(`https://${host}/room/api/auth/google/start${query}`);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('Location'), origin + '/api/auth/google/start' + query);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Set-Cookie'), null);
      assert.equal(response.headers.get('X-Test-Durable-Calls'), '0');
      assert.equal(await response.text(), '');
    }
    for (const [url, method, path] of [
      [origin + '/api/auth/google/start', 'GET', '/api/auth/google/start'],
      ['https://www.getdasha.com/room/api/auth/google/start', 'POST', '/api/auth/google/start'],
      ['https://www.getdasha.com/room/api/account-session', 'GET', '/api/account-session'],
      ['https://www.getdasha.com/room/api/auth/google/link/start', 'GET', '/api/auth/google/link/start']
    ]) {
      const response = await request(url, method);
      assert.equal(response.status, 218);
      assert.equal(response.headers.get('X-Test-Durable-Calls'), '1');
      assert.deepEqual(await response.json(), { url: origin + path, method });
    }
    for (const url of ['https://www.getdasha.com.evil.example/room/api/auth/google/start', 'https://evil.example/api/auth/google/start']) {
      const response = await request(url);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Location'), null);
      assert.equal(response.headers.get('X-Test-Durable-Calls'), '0');
    }
  } finally { await mf.dispose(); }
});
