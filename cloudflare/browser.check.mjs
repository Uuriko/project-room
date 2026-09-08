import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { chromium } from 'playwright';

test('two real browsers use the shared UI on local Workers, including SSE and restart', { timeout: 90000 }, async () => {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'project-room-cf-browser-'));
  const release = JSON.parse(await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  const config = { modules: true, script: bundled.outputFiles[0].text, host: '127.0.0.1', port, https: true,
    compatibilityDate: release.compatibility_date, compatibilityFlags: release.compatibility_flags,
    durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, durableObjectsPersist: persistence,
    bindings: { ROOM_ORIGIN: origin }, serviceBindings: { ASSETS: async request => {
      const pathname = new URL(request.url).pathname;
      if (!/^\/(index\.html|src\/[a-z-]+\.(js|css))$/.test(pathname)) return new Response(null, { status: 404 });
      return new Response(await readFile(new URL('..' + pathname, import.meta.url)));
    } }
  };
  let mf = new Miniflare(config), browser;
  try {
    await mf.ready;
    browser = await chromium.launch({ headless: true });
    const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1360, height: 900 },
      extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.1' } });
    const guestContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.2' } });
    const bootstrap = await ownerContext.request.get(origin + '/__test-provision');
    assert.equal(bootstrap.status(), 200);
    const { ownerKey } = await bootstrap.json();
    const owner = await ownerContext.newPage(); let guest = await guestContext.newPage();
    for (const page of [owner, guest]) page.setDefaultTimeout(12000);
    await owner.goto(origin);
    await owner.locator('#access-key').fill(ownerKey);
    await owner.getByRole('button', { name: 'Enter room', exact: true }).click();
    await owner.locator('#main').waitFor({ state: 'visible' });
    await owner.locator('#invite-people-button').click();
    await owner.locator('#share-link-create').click();
    await owner.locator('#share-link-result').waitFor({ state: 'visible' });
    const invitation = await owner.locator('#share-link-url').inputValue();
    await owner.locator('#share-link-close').click();
    await guest.goto(invitation);
    await guest.locator('#join-link-name').fill('Cloudflare guest');
    await guest.locator('#join-link-submit').click();
    await guest.locator('#main').waitFor({ state: 'visible' });
    await guest.locator('#message-input').fill('Hello from the Cloudflare guest');
    await guest.getByRole('button', { name: 'Send', exact: true }).click();
    await owner.getByText('Hello from the Cloudflare guest', { exact: true }).waitFor();
    await owner.locator('#message-input').fill('Hello back — live updates work');
    await owner.locator('#message-input').press('Enter');
    await guest.getByText('Hello back — live updates work', { exact: true }).waitFor();
    assert.equal(guest.url().includes('#join/'), false);
    const output = fileURLToPath(new URL('./test-results/', import.meta.url));
    await mkdir(output, { recursive: true });
    await owner.screenshot({ path: join(output, 'cloudflare-desktop.png'), fullPage: true });
    await guest.screenshot({ path: join(output, 'cloudflare-mobile.png'), fullPage: true });
    const returnUrl = guest.url(); // Account-mode room selection lives in ?room=.
    // A real browser close must release this credential's stream slot without
    // disconnecting the owner. Previously the fourth visit received stream 429.
    for (let visit = 0; visit < 6; visit++) {
      await guest.close();
      guest = await guestContext.newPage(); guest.setDefaultTimeout(12000);
      const streamStatuses = [];
      guest.on('response', response => {
        if (new URL(response.url()).pathname.endsWith('/stream')) streamStatuses.push(response.status());
      });
      if (visit === 0) await guest.route('**/stream?*', route => route.fulfill({
        status: 429, contentType: 'application/json', body: '{"error":{"code":"stream_limit","message":"Try again shortly"}}'
      }), { times: 1 });
      await guest.goto(returnUrl);
      await guest.locator('#connection-status[data-state="connected"]').waitFor({ state: 'visible' }).catch(error => {
        throw new Error(`Guest return ${visit + 1}: stream statuses ${streamStatuses.join(', ')}`, { cause: error });
      });
      if (visit === 0) assert.deepEqual(streamStatuses, [429, 200], 'a closed stream recovers automatically after a temporary refusal');
      assert.equal(await owner.locator('#connection-status').textContent(), 'Connected');
    }
    await owner.locator('#message-input').fill('Still live after six guest returns');
    await owner.locator('#message-input').press('Enter');
    await guest.getByText('Still live after six guest returns', { exact: true }).waitFor();
    await guest.locator('#message-input').fill('The original peer is still listening');
    await guest.getByRole('button', { name: 'Send', exact: true }).click();
    await owner.getByText('The original peer is still listening', { exact: true }).waitFor();
    // Close only pages, preserving browser session cookies across a real workerd restart.
    await owner.close(); await guest.close();
    await mf.dispose();
    mf = new Miniflare(config); await mf.ready;
    const returned = await guestContext.newPage();
    returned.setDefaultTimeout(12000);
    await returned.goto(returnUrl);
    await returned.locator('#main').waitFor({ state: 'visible' });
    await returned.locator('#message-list').getByText('Hello back — live updates work', { exact: true }).waitFor();
    assert.match(await returned.locator('#identity-label').textContent(), /Cloudflare guest/);
    await returned.screenshot({ path: join(output, 'cloudflare-return.png'), fullPage: true });
    console.log('Local Workers browser screenshots saved; synthetic persistence:', persistence);
  } finally { await browser?.close(); await mf.dispose(); }
});
