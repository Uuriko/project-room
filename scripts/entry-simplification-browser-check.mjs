import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
import { clickChrome, ensureSidebarOpen, ensureSidebarClosed, openSettings, closeSettings } from './room-chrome.mjs';

for (const width of [1280, 390]) test(`entry recovery and room search at ${width}`, { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const accountId = fixture.store.accountForMember('commons', 'owner').id;
  fixture.store.completeOnboarding(accountId);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.querySelector('#github-signin').hidden);
  assert.equal(await page.locator('#github-signin').isVisible(), false);
  await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
  await signInFixture(page, fixture.store.issueAccountAccessKey(accountId));
  await page.locator('#main').waitFor();
  await page.waitForFunction(() => document.querySelector('#room-assistant').hidden);
  assert.equal(await page.locator('#room-assistant').isVisible(), false, 'unconfigured assistant does not occupy ordinary chat');
  assert.equal(await page.locator('#ask-room').count(), 0);
  await openSettings(page);
  await page.locator('#assistant-setup').waitFor();
  assert.equal(await page.locator('#assistant-setup').isVisible(), true, 'assistant setup is available in settings');
  await closeSettings(page);
  assert.equal(await page.locator('#room-assistant').isVisible(), false, 'ordinary chat remains quiet');
  if (width > 940) await ensureSidebarOpen(page);
  else await ensureSidebarClosed(page);
  await clickChrome(page, '#nav-rooms');
  await page.locator('#account-rooms-list button').first().waitFor();
  await page.getByText('Room notes', { exact: true }).waitFor();
  assert.equal(await page.locator('#owner-cockpit-title').isVisible(), false);
  assert.equal(await page.locator('#cockpit-exceptions details').evaluate(node => node.open), false);
  await page.getByText('Room notes', { exact: true }).click();
  assert.equal(await page.locator('#cockpit-exceptions .cockpit-item').first().isVisible(), true);
  await page.getByText('Room notes', { exact: true }).click();
  assert.equal(await page.locator('#choose-room').isVisible(), false);
  assert.equal(await page.getByRole('link', { name: 'Join room', exact: true }).isVisible(), true);
  await page.locator('#account-rooms-search').fill('no-room-with-this-title');
  assert.equal(await page.locator('#account-rooms-list button:visible').count(), 0);
  assert.match(await page.locator('#account-rooms-filter-status').innerText(), /No matching rooms/);
  await page.locator('#account-rooms-search').fill('');
  await page.locator('#account-settings > summary').click();
  await page.locator('#account-settings-body .account-settings').waitFor();
  mkdirSync('test-results/entry', { recursive: true });
  await page.locator('#account-settings > summary').click();
  await page.locator('#account-rooms-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/entry/rooms-${width}.png` });
  await page.locator('#account-settings > summary').click();
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await page.locator('#account-settings > summary').click();
  await page.locator('#account-rooms-title').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/entry/rooms-${width}-light.png` });
  await page.locator('#account-rooms-list button').first().click();
  await page.locator('#main').waitFor();
  let answer = 'failed';
  await page.route('**/referrals', route => route.fulfill({ status: answer === 'failed' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(answer === 'failed' ? { error: { message: 'Unavailable' } } : { invite: null }) }));
  await clickChrome(page, '#invite-people-button');
  await page.locator('#growth-kit-retry').waitFor();
  assert.equal(await page.locator('#growth-kit-status').isVisible(), true);
  assert.match(await page.locator('#growth-kit-status').innerText(), /Try again/);
  answer = 'empty';
  await page.locator('#growth-kit-retry').click();
  await page.waitForFunction(() => document.querySelector('#growth-kit-status').textContent.includes('Create an invite link below'));
  assert.equal(await page.locator('#growth-copy-link').isDisabled(), true);
  assert.equal(await page.locator('#growth-kit-status').isVisible(), true);
  await page.screenshot({ path: `test-results/entry/invite-unavailable-${width}.png` });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

// Hold the real entry resource before startup can remove the static fallback.
// This catches first-paint regressions that settled sign-in screenshots miss.
for (const width of [390, 1280]) for (const javaScriptEnabled of [true, false]) {
  test(`startup at ${width}: scripting ${javaScriptEnabled ? 'delayed' : 'disabled'}`, { timeout: 30000 }, async t => {
    const fixture = createAcceptanceFixture(), server = createRoomServer({ store: fixture.store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(async () => { release(); await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width, height: 900 }, javaScriptEnabled });
    if (javaScriptEnabled) await page.route('**/src/entry.js', async route => { await gate; await route.continue(); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'commit' });
    await page.waitForFunction(() => [...document.querySelectorAll('link[rel="stylesheet"]')].every(link => link.sheet));
    mkdirSync('test-results/startup', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.screenshot({ path: `test-results/startup/${width}-${theme}-${javaScriptEnabled ? 'delayed' : 'nojs'}.png`, fullPage: true });
    }
    assert.equal(await page.locator('#static-hero').isVisible(), !javaScriptEnabled, 'fallback content is for nonscripting browsers, not a loading flash');
    assert.equal(await page.locator('.app-shell > .topbar').isVisible(), javaScriptEnabled, 'no-JS visitors do not see inert session controls');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (javaScriptEnabled) {
      release();
      await page.locator('#auth-panel').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#static-hero').count(), 0);
      await page.locator('#auth-panel input[type="email"]').waitFor({ state: 'visible' });
    } else {
      assert.equal(await page.getByText('JavaScript is off. Enable JavaScript to sign in.', { exact: true }).isVisible(), true);
    }
  });
}

test('a failed sign-in module can recover through the visible reload action', { timeout: 30000 }, async t => {
  const fixture = createAcceptanceFixture(), server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.route('**/src/signin-entry.js', route => route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#entry-retry').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth-error').isVisible(), true);
  mkdirSync('test-results/startup', { recursive: true });
  await page.screenshot({ path: 'test-results/startup/failed-module.png' });
  await page.unroute('**/src/signin-entry.js');
  await page.locator('#entry-retry').click();
  await page.locator('#auth-panel input[type="email"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#entry-retry').count(), 0);
  await page.screenshot({ path: 'test-results/startup/recovered-module.png' });
});
