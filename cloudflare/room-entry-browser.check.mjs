import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { chromium } from 'playwright';

// Deployment preserves function names. A source-level browser server cannot
// detect helpers introduced by bundling a function later serialized as text.
test('bundled public door executes under CSP and preserves invitation and room links', { timeout: 60000 }, async t => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./room.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    keepNames: true, external: ['node:*', 'cloudflare:*']
  });
  const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.trydemigod.com' }
  });
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://www.getdasha.com/room/');
  const html = await response.text();
  assert.equal(response.status, 200, html);
  // Resolve the actual bundled response hints as an outside agent on the
  // shared Dasha host would, rather than accepting a matching path substring.
  const discoveryTargets = [...(response.headers.get('link') ?? '').matchAll(/<([^>]+)>/g)]
    .map(match => new URL(match[1], 'https://www.getdasha.com/room/').href);
  assert.deepEqual(discoveryTargets, [
    'https://room.trydemigod.com/.well-known/agent-card.json',
    'https://room.trydemigod.com/llms.txt',
    'https://room.trydemigod.com/skills',
    'https://room.trydemigod.com/room'
  ], 'alternate entry discovery leads to Project Room, not the shared host apex');
  const headers = Object.fromEntries(response.headers);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    const forwards = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://www.getdasha.com/room/**', route => route.fulfill({ status: 200, headers, body: html }));
    await page.route('https://room.trydemigod.com/**', route => {
      forwards.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Destination</title>' });
    });
    await page.goto('https://www.getdasha.com/room/');
    assert.deepEqual(errors, [], `entry script runs at width ${width}`);
    await page.evaluate(() => { globalThis.location.hash = '#room/qa-room'; });
    await page.waitForFunction(() => globalThis.document.querySelector('a.open')?.href.includes('?room=qa-room'));
    assert.equal(await page.locator('a.open').getAttribute('href'), 'https://room.trydemigod.com/?room=qa-room#room/qa-room');
    await page.evaluate(() => { globalThis.location.hash = '#join/short'; });
    await page.locator('#join-empty').waitFor({ state: 'visible' });
    assert.equal(forwards.length, 0, 'incomplete invitation remains local');
    const token = 'A'.repeat(43);
    await page.evaluate(value => { globalThis.location.hash = '#join/' + value; }, token);
    await page.waitForURL('https://room.trydemigod.com/#join/' + token);
    assert.equal(forwards.length, 1, 'complete invitation forwards once');
    await page.goto('https://www.getdasha.com/room/#join/' + token);
    await page.waitForURL('https://room.trydemigod.com/#join/' + token);
    assert.equal(forwards.length, 2, 'initial invitation arrival forwards once');
    await page.goto('https://www.getdasha.com/room/#room/qa-room');
    await page.locator('a.open').click();
    await page.waitForURL('https://room.trydemigod.com/?room=qa-room#room/qa-room');
    assert.deepEqual(errors, []);
    await context.close();
  }
});
