import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Static and discovery responses must not enter invite-only-pilot. A probe
// that only watches /api/version/worker cannot see this: that route already
// bypassed the object. This wraps ProjectRoom.fetch and counts calls.
test('static assets and discovery documents do not enter the Durable Object', async () => {
  const cloudflareDir = fileURLToPath(new URL('.', import.meta.url));
  const bundled = await build({
    stdin: {
      contents: `
        import worker, { ProjectRoom } from './room.mjs';
        let doFetches = 0;
        const original = ProjectRoom.prototype.fetch;
        ProjectRoom.prototype.fetch = async function(request) {
          doFetches += 1;
          return original.call(this, request);
        };
        export { ProjectRoom };
        export default {
          async fetch(request, env, ctx) {
            const url = new URL(request.url);
            if (url.pathname === '/__do_fetches') return new Response(String(doFetches));
            const before = doFetches;
            const response = await worker.fetch(request, env, ctx);
            const headers = new Headers(response.headers);
            headers.set('X-Test-Do-Fetches', String(doFetches - before));
            return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
          }
        };
      `,
      resolveDir: cloudflareDir,
      loader: 'js'
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
  });
  const origin = 'https://room.example.test';
  let assetFetches = 0;
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: origin, ROOM_DEPLOYMENT: 'staging' },
    serviceBindings: {
      ASSETS: async request => {
        assetFetches += 1;
        const path = new URL(request.url).pathname;
        const bodies = { '/index.html': '<div id="message-input">', '/about.html': 'about-page', '/src/app.js': 'app-js' };
        if (!bodies[path]) return new Response(null, { status: 404 });
        return new Response(bodies[path]);
      }
    }
  });
  const call = (path, { method = 'GET', ip, headers = {} } = {}) => mf.dispatchFetch(origin + path, {
    method, redirect: 'manual',
    headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers }
  });
  try {
    const page = await call('/');
    assert.equal(page.status, 200, await page.clone().text());
    assert.equal(page.headers.get('x-test-do-fetches'), '0');
    assert.match(await page.text(), /message-input/);
    assert.match(page.headers.get('server-timing'), /total;dur=/);
    assert.match(page.headers.get('link'), /llms\.txt/);
    assert.equal(page.headers.get('x-robots-tag'), 'all');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

    const about = await call('/about');
    assert.equal(about.headers.get('x-test-do-fetches'), '0');
    assert.equal(about.headers.get('x-robots-tag'), 'all');
    assert.match(about.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
    assert.equal(await about.text(), 'about-page');
    const alias = await call('/about.html');
    assert.equal(alias.status, 301);
    assert.equal(alias.headers.get('location'), '/about');
    assert.equal(alias.headers.get('x-test-do-fetches'), '0');

    const script = await call('/src/app.js');
    assert.equal(script.headers.get('x-test-do-fetches'), '0');
    assert.equal(await script.text(), 'app-js');
    const scriptAgain = await call('/src/app.js');
    assert.equal(await scriptAgain.text(), 'app-js');
    const fetchesAfterScripts = assetFetches;
    await call('/src/app.js');
    assert.equal(assetFetches, fetchesAfterScripts, 'a repeated static asset must not refetch ASSETS');

    const packet = await call('/llms.txt');
    assert.equal(packet.status, 200);
    assert.equal(packet.headers.get('x-test-do-fetches'), '0');
    assert.match(packet.headers.get('content-type'), /text\/plain/);
    assert.match(await packet.text(), /Project Room/);
    const agents = await call('/agents.json');
    assert.equal(agents.status, 200);
    assert.equal(agents.headers.get('x-test-do-fetches'), '0');
    assert.equal(typeof (await agents.json()), 'object');
    const card = await call('/mcp/server-card');
    assert.equal(card.status, 200, await card.clone().text());
    assert.equal(card.headers.get('x-test-do-fetches'), '0');
    assert.match(card.headers.get('content-type'), /mcp-server-card/);
    const spec = await call('/openapi.json');
    assert.equal(spec.status, 200, await spec.clone().text());
    assert.equal(spec.headers.get('x-test-do-fetches'), '0');
    assert.equal(typeof (await spec.json()).openapi, 'string');
    const denied = await call('/llms.txt', { method: 'POST' });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get('x-test-do-fetches'), '0');

    const health = await call('/api/health', { ip: '192.0.2.9' });
    assert.equal(health.status, 200, await health.clone().text());
    assert.equal(health.headers.get('x-test-do-fetches'), '1');
    assert.match(health.headers.get('server-timing'), /total;dur=/);
    assert.match(health.headers.get('server-timing'), /app;dur=/);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.deepEqual(healthBody.durableObject, { ready: true, status: 200 });
  } finally {
    await mf.dispose();
  }
});
