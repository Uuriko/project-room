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
        let doProbes = 0;
        const original = ProjectRoom.prototype.fetch;
        ProjectRoom.prototype.fetch = async function(request) {
          doFetches += 1;
          return original.call(this, request);
        };
        const originalProbe = ProjectRoom.prototype.probeStorage;
        ProjectRoom.prototype.probeStorage = function() {
          doProbes += 1;
          return originalProbe.call(this);
        };
        export { ProjectRoom };
        export default {
          async fetch(request, env, ctx) {
            const url = new URL(request.url);
            if (url.pathname === '/__do_fetches') return new Response(String(doFetches));
            const fetchesBefore = doFetches;
            const probesBefore = doProbes;
            const response = await worker.fetch(request, env, ctx);
            const headers = new Headers(response.headers);
            headers.set('X-Test-Do-Fetches', String(doFetches - fetchesBefore));
            headers.set('X-Test-Do-Probes', String(doProbes - probesBefore));
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
        const bodies = { '/index.html': '<div id="message-input">', '/about.html': 'about-page', '/src/app.js': 'app-js', '/manifest.webmanifest': '{"name":"Room"}' };
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
    assert.equal(page.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');

    const manifest = await call('/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('x-test-do-fetches'), '0');
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    const security = await call('/.well-known/security.txt');
    assert.equal(security.status, 404);
    assert.equal(security.headers.get('x-test-do-fetches'), '0');
    assert.match(await security.text(), /Not found/);

    const about = await call('/about');
    assert.equal(about.headers.get('x-test-do-fetches'), '0');
    assert.equal(about.headers.get('x-robots-tag'), 'all');
    assert.match(about.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(about.headers.get('content-security-policy'), /script-src https:\/\/static\.cloudflareinsights\.com/);
    assert.equal(about.headers.get('content-security-policy').split('; ').find(d => d.startsWith('connect-src ')), `connect-src https://cloudflareinsights.com ${origin}/cdn-cgi/rum`);
    assert.doesNotMatch(about.headers.get('content-security-policy'), /connect-src 'self'|script-src 'self'|\*/);
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

    const missing = await call('/compare/project-room-vs-slack', { headers: { Accept: 'text/html' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-test-do-fetches'), '0');
    assert.equal(missing.headers.get('x-robots-tag'), 'noindex');
    assert.match(missing.headers.get('content-type'), /text\/html/);
    const missingHtml = await missing.text();
    assert.match(missingHtml, /<html lang="en">/);
    assert.match(missingHtml, /<title>Page not found<\/title>/);
    assert.match(missingHtml, /<h1>Page not found<\/h1>/);
    assert.match(missingHtml, /href="\/"/);
    assert.match(missingHtml, /href="\/about"/);
    assert.match(missingHtml, /href="\/receipts"/);
    const missingClient = await call('/compare/project-room-vs-slack');
    assert.equal(missingClient.status, 404);
    assert.equal(missingClient.headers.get('x-test-do-fetches'), '0');
    assert.equal(await missingClient.text(), 'Not found\n');

    const health = await call('/api/health', { ip: '192.0.2.9' });
    assert.equal(health.status, 200, await health.clone().text());
    assert.equal(health.headers.get('x-test-do-fetches'), '0');
    assert.equal(health.headers.get('x-test-do-probes'), '0');
    assert.match(health.headers.get('server-timing'), /total;dur=/);
    const healthBody = await health.json();
    assert.deepEqual(healthBody, { status: 'ok', mode: 'cloudflare-staging', deployment: 'staging' });

    const ready = await call('/api/ready', { ip: '192.0.2.9' });
    assert.equal(ready.status, 200, await ready.clone().text());
    assert.equal(ready.headers.get('x-test-do-fetches'), '0');
    assert.equal(ready.headers.get('x-test-do-probes'), '1');
    const readyBody = await ready.json();
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.do.status, 'ok');
    assert.equal(readyBody.do.statusCode, 200);
    assert.equal(typeof readyBody.do.ms, 'number');
  } finally {
    await mf.dispose();
  }
});

test('security.txt is served from the edge when a contact is configured', async () => {
  const cloudflareDir = fileURLToPath(new URL('.', import.meta.url));
  const bundled = await build({
    stdin: {
      contents: `
        import { edgePublicResponse } from './edge-public.mjs';
        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            const response = await edgePublicResponse(request, env, url);
            return response ?? new Response('fallthrough', { status: 599 });
          }
        };
      `,
      resolveDir: cloudflareDir,
      loader: 'js'
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']
  });
  const mf = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    bindings: { ROOM_SECURITY_CONTACT: 'security@example.com', ROOM_ORIGIN: 'https://room.example.test' }
  });
  try {
    const response = await mf.dispatchFetch('https://room.example.test/.well-known/security.txt');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    const body = await response.text();
    assert.match(body, /Contact: mailto:security@example.com/);
    assert.ok(Date.parse(/^Expires: (.+)$/m.exec(body)[1]) > Date.now());
    const door = await mf.dispatchFetch('https://room.example.test/room/.well-known/security.txt');
    assert.equal(door.status, 200);
    assert.match(await door.text(), /Contact: mailto:security@example.com/);
  } finally {
    await mf.dispose();
  }
});
