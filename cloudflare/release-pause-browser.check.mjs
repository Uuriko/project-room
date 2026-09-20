// Disposable workerd/browser release recovery proof; never provisions live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { chromium } from 'playwright';
import { fillAccessKey } from '../scripts/auth-signin.mjs';

for (const touch of [false, true]) test(`release pause/resume preserves exact sends and privacy: ${touch ? 'touch' : 'desktop'}`, { timeout: 90000 }, async () => {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'room-release-pause-'));
  const release = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  const config = { modules: true, script: bundled.outputFiles[0].text, host: '127.0.0.1', port, https: true,
    compatibilityDate: release.compatibility_date, compatibilityFlags: release.compatibility_flags,
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, durableObjectsPersist: persistence,
    serviceBindings: { ASSETS: async request => {
      const pathname = new URL(request.url).pathname;
      if (!/^\/(index\.html|src\/[a-z-]+\.(js|css))$/.test(pathname)) return new Response(null, { status: 404 });
      return new Response(await readFile(new URL('..' + pathname, import.meta.url)));
    } } };
  let mf, browser;
  const start = async paused => {
    await mf?.dispose();
    mf = new Miniflare({ ...config, bindings: { ROOM_ORIGIN: origin, ROOM_MAINTENANCE: paused ? '1' : '0' } });
    await mf.ready;
  };
  try {
    await start(false);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      isMobile: touch, hasTouch: touch, reducedMotion: 'reduce', extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.1' } });
    const bootstrap = await context.request.get(origin + '/__test-provision');
    assert.equal(bootstrap.status(), 200);
    const { ownerKey } = await bootstrap.json();
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin); await fillAccessKey(page, ownerKey);
    await page.getByRole('button', { name: 'Enter room', exact: true }).click();
    await page.locator('#main').waitFor({ state: 'visible' });
    await page.locator('#invite-people-button').click();
    await page.locator('#share-link-create').click();
    await page.locator('#share-link-result').waitFor({ state: 'visible' });
    const invitation = await page.locator('#share-link-url').inputValue();
    await page.locator('#share-link-close').click();
    const guestContext = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.2' } });
    const guest = await guestContext.newPage();
    await guest.goto(invitation); await guest.locator('#join-link-name').fill('Recovery guest');
    await guest.locator('#join-link-submit').click(); await guest.locator('#main').waitFor({ state: 'visible' });
    await guestContext.close();
    const options = async () => { if (!await page.locator('#remember-drafts').isVisible()) await page.locator('#composer-options > summary').click(); };
    await options(); await page.locator('#remember-drafts').check();
    const drafts = () => page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)
      .filter(([key]) => /^project-room:drafts:v\d+$/.test(key)).map(([key, raw]) => {
        const saved = JSON.parse(raw);
        // The outgoing application's pagehide handler renews expiry when saving.
        // Compare every semantic field, including exact command bytes and scope.
        if (saved.expires <= Date.now() || saved.expires > Date.now() + 12 * 60 * 60 * 1000) throw new Error('Invalid draft expiry');
        delete saved.expires;
        return [key, saved];
      })));

    for (const request of [false, true]) {
      if (request) {
        await options(); await page.locator('#request-reply').click();
        const guestId = await page.locator('#message-to-select option').filter({ hasText: 'Recovery guest' }).getAttribute('value');
        await page.locator('#message-to-select').selectOption(guestId);
      }
      const body = request ? 'Request awaiting exact receipt' : 'Ordinary send awaiting exact receipt';
      const commands = [], receipts = [];
      await page.route('**/api/rooms/commons/commands', async route => {
        commands.push(route.request().postDataJSON());
        const response = await route.fetch(); receipts.push(await response.json());
        if (commands.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      await page.locator('#message-input').fill(body);
      await page.locator('#message-form button[type=submit]').click();
      await page.waitForFunction(() => !document.querySelector('#message-input').disabled && document.querySelector('#composer-status').classList.contains('error'));
      assert.equal(await page.locator('#message-input').evaluate(node => node.readOnly), request);
      assert.equal(receipts[0].duplicate, false);
      const saved = await drafts();
      assert.ok(JSON.stringify(saved).includes(commands[0].id));
      await page.goto('about:blank');
      await start(true);
      const paused = await page.goto(origin); assert.equal(paused.status(), 503);
      assert.equal(paused.headers()['cache-control'], 'no-store');
      assert.equal(paused.headers()['set-cookie'], undefined);
      assert.match(await page.locator('body').innerText(), /temporarily paused/);
      assert.equal(await page.locator('script').count(), 0);
      assert.deepEqual(await drafts(), saved, 'maintenance never rewrites browser drafts');
      const refused = await context.request.post(origin + '/api/rooms/commons/commands', { data: commands[0] });
      assert.equal(refused.status(), 503);
      await start(false); await page.goto(origin); await page.locator('#main').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#message-input').inputValue(), body);
      assert.equal(await page.locator('#message-input').evaluate(node => node.readOnly), request);
      await page.locator('#message-form button[type=submit]').click();
      await page.waitForFunction(() => !document.querySelector('#message-input').disabled && !document.querySelector('#message-input').value);
      assert.equal(commands.length, 2); assert.deepEqual(commands[1], commands[0]);
      assert.equal(receipts[1].duplicate, true);
      assert.equal(receipts[1].event.id, receipts[0].event.id);
      assert.equal(receipts[1].sequence, receipts[0].sequence);
      await page.unroute('**/api/rooms/commons/commands');
    }
    await page.locator('#message-input').fill('Private draft cleared on sign-out');
    if (await page.locator('#session-menu-button').isVisible()) await page.locator('#session-menu-button').click();
    await page.locator('#signout-button').click(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.deepEqual(await drafts(), {});
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await mf?.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
