import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { publicAssetPaths } from '../deploy/public-assets.mjs';

function assertPublicPolicy(response, origin) {
  const directives = Object.fromEntries(response.headers.get('content-security-policy').split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/); return [name, values.join(' ')];
  }));
  assert.deepEqual(directives, {
    'default-src': "'none'", 'script-src': 'https://static.cloudflareinsights.com',
    'style-src': "'unsafe-inline'", 'connect-src': `https://cloudflareinsights.com ${origin}/cdn-cgi/rum`,
    'img-src': "'self'", 'manifest-src': "'self'", 'base-uri': "'none'",
    'form-action': "'none'", 'frame-ancestors': "'none'"
  });
}

test('actual Worker public search routes load packaged HTML and preserve private/error indexing defaults', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  // Asset bytes are cached for the life of the isolate. A deploy that drops
  // about.html starts a new isolate, so the missing-file contract is checked
  // on its own Worker, not by toggling the binding under a warm cache.
  const start = missing => new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin },
    serviceBindings: { ASSETS: async request => {
      const path = new URL(request.url).pathname.slice(1);
      if (!publicAssetPaths.includes(path) || (missing && path === 'about.html')) return new Response(null, { status: 404 });
      return new Response(await readFile(new URL('../' + path, import.meta.url)));
    } }
  });
  const call = (mf, path, method = 'GET') => mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  const present = start(false);
  try {
    const page = await call(present, '/about'); assert.equal(page.status, 200); assert.equal(page.headers.get('x-robots-tag'), 'all');
    assertPublicPolicy(page, origin);
    assert.match(page.headers.get('content-security-policy'), /script-src https:\/\/static\.cloudflareinsights\.com/);
    assert.match(page.headers.get('content-security-policy'), /connect-src https:\/\/cloudflareinsights\.com/);
    assert.match(page.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
    assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /Work with your agents in one room/);
    const head = await call(present, '/about', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const alias = await call(present, '/about.html'); assert.equal(alias.status, 301); assert.equal(alias.headers.get('location'), '/about');
    const home = await call(present, '/'); assert.equal(home.status, 200); assert.equal(home.headers.get('x-robots-tag'), 'all');
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    const offers = await call(present, '/offers'); assert.equal(offers.status, 200); assert.equal(offers.headers.get('x-robots-tag'), 'all');
    for (const path of ['/index.html', '/join.html', '/api/version', '/about?secret=synthetic', '/compare/not-reviewed']) {
      const response = await call(present, path); assert.match(response.headers.get('x-robots-tag'), /noindex/, path);
    }
    for (const file of publicAssetPaths.filter(path => path.startsWith('compare/') && path.endsWith('.html'))) {
      const canonical = '/' + file.slice(0, -5);
      const page = await call(present, canonical); assert.equal(page.status, 200, canonical); assert.equal(page.headers.get('x-robots-tag'), 'all', canonical);
      assertPublicPolicy(page, origin);
      assert.match(await page.text(), new RegExp('rel="canonical" href="https://room.trydemigod.com' + canonical + '"'));
    }
    const doorAbout = await present.dispatchFetch('https://www.getdasha.com/room/about', { method: 'GET', redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    assert.equal(doorAbout.status, 200);
    assert.equal(doorAbout.headers.get('x-robots-tag'), 'all');
    assert.match(doorAbout.headers.get('link') ?? '', /<https:\/\/room\.trydemigod\.com\/about>; rel="canonical"/);
    const doorOffers = await present.dispatchFetch('https://www.getdasha.com/room/offers', { method: 'GET', redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    assert.equal(doorOffers.status, 200);
    assert.match(doorOffers.headers.get('link') ?? '', /<https:\/\/room\.trydemigod\.com\/offers>; rel="canonical"/);
    // The outer Worker must retain browser origin across its canonical-origin
    // rewrite for both edge-served marketing and DO-served public HTML.
    const publicPaths = ['/about', '/receipts', '/templates', '/docs/agents',
      ...publicAssetPaths.filter(path => path.startsWith('compare/') && path.endsWith('.html')).map(file => '/' + file.slice(0, -5))];
    for (const path of ['/receipts', '/templates', '/agents']) {
      const response = await call(present, path); assert.equal(response.status, 200, path);
      assertPublicPolicy(response, origin);
    }
    for (const door of ['https://www.getdasha.com', 'https://getdasha.com']) for (const path of publicPaths) {
      const response = await present.dispatchFetch(door + '/room' + path, { headers: {
        'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-Host': 'csp-denied.example', Forwarded: 'host=csp-denied.example;proto=http'
      } });
      assert.equal(response.status, 200, door + path);
      assertPublicPolicy(response, door);
    }
    // /room/agents is an existing machine-discovery alias, not /agents HTML.
    const agentPacket = await present.dispatchFetch('https://www.getdasha.com/room/agents');
    assert.equal(agentPacket.status, 200);
    assert.doesNotMatch(agentPacket.headers.get('content-security-policy') ?? '', /cdn-cgi\/rum/);
    for (const target of ['https://csp-denied.example/about', 'https://www.getdasha.com.evil.example/room/about']) {
      const response = await present.dispatchFetch(target, { headers: { Host: new URL(origin).host, 'CF-Connecting-IP': '192.0.2.1' } });
      assert.equal(response.status, 403, target);
      assert.equal(response.headers.get('content-security-policy'), null);
    }
    for (const path of ['/rooms', '/roommates', '/roomnot/about']) {
      const response = await present.dispatchFetch('https://www.getdasha.com' + path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('content-security-policy'), null);
    }
    const receiptsJson = await call(present, '/api/public/receipts');
    assert.equal(receiptsJson.status, 200);
    assert.match(receiptsJson.headers.get('content-type'), /application\/json/);
    for (const response of [home, offers, await call(present, '/api/version'), receiptsJson]) {
      assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /cdn-cgi\/rum/);
    }
    const map = await call(present, '/sitemap.xml'); assert.equal(map.status, 200); assert.equal(map.headers.get('x-robots-tag'), 'all');
    const sitemap = await map.text(); assert.match(sitemap, /\/about/); assert.match(sitemap, /<loc>https:\/\/room\.trydemigod\.com\/<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/room\.trydemigod\.com\/offers<\/loc>/); assert.match(sitemap, /\/compare\/project-room-vs-slack/);
  } finally { await present.dispose(); }
  const absent = start(true);
  try {
    const failed = await call(absent, '/about'); assert.equal(failed.status, 404); assert.match(failed.headers.get('x-robots-tag'), /noindex/);
    assert.doesNotMatch(await (await call(absent, '/sitemap.xml')).text(), /\/about/);
  } finally { await absent.dispose(); }
});
