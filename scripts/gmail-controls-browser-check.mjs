import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const mobile of [false, true]) test(`Gmail connection disclosure, sync and disconnect (${mobile ? 'mobile' : 'desktop'})`, async t => {
  const f = createAcceptanceFixture(); const calls = []; let connected = true;
  const key = f.store.issueAccountAccessKey(f.store.accountForMember('commons', 'owner').id);
  const gmailConnections = {
    list: () => [{ connectionId: 'gmail-fixture', mailbox: 'pilot@example.com', state: connected ? 'connected' : 'disconnected' }],
    sync: () => { calls.push('sync'); return { connectionId: 'gmail-fixture', imported: 0, complete: true }; },
    disconnect: () => { calls.push('disconnect'); connected = false; return { connectionId: 'gmail-fixture', state: 'disconnected', providerRevoked: false }; }
  };
  const server = createRoomServer({ store: f.store, gmailConnections }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
  await page.locator('#sign-in-entry').click();
  await page.locator('#access-key').fill(key); await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#main').waitFor({ state: 'visible' }); await page.locator('#nav-inbox').click();
  assert.equal(await page.locator('#inbox-gmail-address').isVisible(), false);
  await page.locator('#inbox-connections summary').click(); await page.locator('#inbox-gmail-address').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Sync pilot@example.com', exact: true }).click();
  await page.getByText('Inbox updated.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Disconnect pilot@example.com', exact: true }).click();
  await page.getByText('Disconnected here. Google revocation unconfirmed.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reconnect pilot@example.com', exact: true }).waitFor();
  assert.deepEqual(calls, ['sync', 'disconnect']); assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#inbox-gmail-address').fill('unsent-private@example.com');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#signout-button').click();
  await page.waitForFunction(() => document.querySelector('#inbox-gmail-address').value === '' && document.querySelector('#inbox-connection-list').childElementCount === 0);
  assert.equal(await page.locator('#inbox-connections').evaluate(element => element.open), false);
});
