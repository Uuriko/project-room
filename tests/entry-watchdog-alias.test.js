// Preserve the useful HTTP alias coverage from peer PR #5306 without
// replacing #5309's browser-tested, late-start-safe recovery implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

test('root and /room/ serve the independent watchdog and matching recovery surface', async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom('commons'));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const expected = readFileSync(new URL('../src/entry-watchdog.js', import.meta.url), 'utf8');
  for (const prefix of ['', '/room']) {
    const page = await fetch(`${origin}${prefix}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
    const watchdog = scripts.find(([, attrs]) => attrs.includes('entry-watchdog.js'));
    assert.ok(watchdog, `${prefix || '/'} includes independent watchdog`);
    assert.doesNotMatch(watchdog[1], /\btype\s*=\s*["']module["']/);
    const src = /\bsrc="([^"]+)"/.exec(watchdog[1])?.[1];
    const assetUrl = new URL(src, page.url);
    assert.ok(['/src/entry-watchdog.js', '/room/src/entry-watchdog.js'].includes(assetUrl.pathname));
    assert.match(html, /id="entry-load-recovery"/);
    assert.match(html, /id="entry-load-retry"/);
    assert.match(html, /id="entry-module"/);
    const loadedAsset = await fetch(assetUrl);
    assert.equal(loadedAsset.status, 200, 'page script resolves successfully');
    assert.equal(await loadedAsset.text(), expected);
    const asset = await fetch(`${origin}${prefix}/src/entry-watchdog.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await asset.text(), expected, 'both routes serve the actual watchdog, not an HTML fallback');
  }
});
