import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { publicAssetPaths } from '../deploy/public-assets.mjs';

test('actual Worker public search routes load packaged HTML and preserve private/error indexing defaults', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const origin = 'https://room.example.test';
  let missing = false;
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin },
    serviceBindings: { ASSETS: async request => {
      const path = new URL(request.url).pathname.slice(1);
      if (!publicAssetPaths.includes(path) || (missing && path === 'about.html')) return new Response(null, { status: 404 });
      return new Response(await readFile(new URL('../' + path, import.meta.url)));
    } }
  });
  const call = (path, method = 'GET') => mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  try {
    const page = await call('/about'); assert.equal(page.status, 200); assert.equal(page.headers.get('x-robots-tag'), 'all');
    assert.match(page.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
    assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /Work with your agents in one room/);
    const head = await call('/about', 'HEAD'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const alias = await call('/about.html'); assert.equal(alias.status, 301); assert.equal(alias.headers.get('location'), '/about');
    for (const path of ['/', '/index.html', '/join.html', '/api/version', '/about?secret=synthetic', '/compare/not-reviewed']) {
      const response = await call(path); assert.match(response.headers.get('x-robots-tag'), /noindex/, path);
    }
    for (const file of publicAssetPaths.filter(path => path.startsWith('compare/') && path.endsWith('.html'))) {
      const canonical = '/' + file.slice(0, -5);
      const page = await call(canonical); assert.equal(page.status, 200, canonical); assert.match(page.headers.get('x-robots-tag'), /noindex/, canonical);
      assert.match(await page.text(), new RegExp('rel="canonical" href="https://room.trydemigod.com' + canonical + '"'));
    }
    const map = await call('/sitemap.xml'); assert.equal(map.status, 200); assert.equal(map.headers.get('x-robots-tag'), 'all');
    const sitemap = await map.text(); assert.match(sitemap, /\/about/); assert.doesNotMatch(sitemap, /compare/);
    missing = true;
    const failed = await call('/about'); assert.equal(failed.status, 500); assert.match(failed.headers.get('x-robots-tag'), /noindex/);
    assert.doesNotMatch(await (await call('/sitemap.xml')).text(), /\/about/);
  } finally { await mf.dispose(); }
});
