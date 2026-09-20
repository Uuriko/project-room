// Exact pre-release live client -> candidate upgrade; disposable local data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRuntimePackage } from './runtime-package.mjs';
import { fillAccessKey } from './auth-signin.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const liveCommit = '7db8896a9d18523e48bb7e659c2d1feb16131f27';
for (const touch of [false, true]) test(`live client upgrade preserves pending ordinary sends: ${touch ? 'touch' : 'desktop'}`, { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'room-live-upgrade-')), fixture = createAcceptanceFixture();
  const oldPath = join(directory, 'live');
  createRuntimePackage({ repository, commit: liveCommit, destination: oldPath });
  let browser, server, store, port;
  const stop = async () => {
    if (server) { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
    store?.close(); store = null;
  };
  const start = async path => {
    await stop();
    const { RoomStore } = await import(pathToFileURL(join(path, 'server/store.mjs')));
    const { createRoomServer } = await import(pathToFileURL(join(path, 'server/http.mjs')));
    store = new RoomStore(join(fixture.directory, 'room.sqlite'));
    server = createRoomServer({ store, streamInterval: 50 });
    await new Promise(resolve => server.listen(port ?? 0, '127.0.0.1', resolve)); port = server.address().port;
  };
  try {
    browser = await chromium.launch({ headless: true });
    await start(oldPath);
    const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch });
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('dialog', dialog => dialog.accept());
    await page.goto(`http://127.0.0.1:${port}`); await fillAccessKey(page, fixture.keys.owner);
    await page.locator('#auth-form button[type=submit]').click(); await page.locator('#main').waitFor({ state: 'visible' });
    if (!await page.locator('#remember-drafts').isVisible()) await page.locator('#composer-options > summary').click();
    await page.locator('#remember-drafts').check();
    const body = 'Live pending ordinary message';
    const commands = [], receipts = [];
    await page.route('**/api/rooms/commons/commands', async route => {
      commands.push(route.request().postDataJSON()); const response = await route.fetch(); receipts.push(await response.json());
      if (commands.length === 1) await route.abort('failed'); else await route.fulfill({ response });
    });
    await page.locator('#message-input').fill(body); await page.locator('#message-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#message-input').disabled && document.querySelector('#composer-status').classList.contains('error'));
    assert.equal(receipts[0].duplicate, false, JSON.stringify(receipts[0]));
    await start(repository);
    // Two reloads also test re-saving a legacy pending command in the new client.
    for (let reload = 0; reload < 2; reload++) {
      await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#message-input').inputValue(), body);
      assert.equal(await page.locator('#message-input').evaluate(node => node.readOnly), false);
    }
    await page.locator('#message-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#message-input').disabled && !document.querySelector('#message-input').value);
    assert.equal(commands.length, 2); assert.deepEqual(commands[1], commands[0], 'upgrade must retry original command bytes and identity');
    assert.equal(receipts[1].duplicate, true); assert.equal(receipts[1].event.id, receipts[0].event.id);
    await context.close();
  } finally {
    await browser?.close(); await stop(); fixture.store.close();
    rmSync(directory, { recursive: true, force: true }); rmSync(fixture.directory, { recursive: true, force: true });
  }
});
