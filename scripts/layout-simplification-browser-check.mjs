import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { fillAccessKey } from './auth-signin.mjs';
import { ensureSidebarOpen, ensureSidebarClosed, openSettings, closeSettings } from './room-chrome.mjs';

for (const [width, account] of [[1440, false], [390, false], [320, false], [1440, true], [390, true]]) {
  test(`conversation layout at ${width}px (${account ? "account" : "room key"}) preserves navigation, drafts and usable controls`, { timeout: 60000 }, async t => {
    const fixture = createAcceptanceFixture();
    const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 500, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const accountId = fixture.store.accountForMember('commons', 'owner').id;
    fixture.store.completeOnboarding(accountId);
    const key = account ? fixture.store.issueAccountAccessKey(accountId) : fixture.keys.owner;
    await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
    await fillAccessKey(page, key);
    await page.locator(account ? '#auth-kind-account' : '#auth-kind-room').click();
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#main').waitFor({ state: 'visible' });
    await page.locator('.room-topbar #session-menu').waitFor();
    assert.equal(await page.locator('.app-shell > .topbar').isVisible(), false);
    for (const selector of ['#topbar-search-toggle', '#topbar-catchup', '#topbar-settings', '#session-menu-button']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${selector} remains in viewport`);
      assert.ok(box.width >= 24 && box.height >= 24, `${selector} has a usable target`);
    }
    assert.ok(await page.locator('#conversation-title').boundingBox());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (account) {
      await ensureSidebarOpen(page);
      assert.equal(await page.locator(width > 940 ? '#sidebar-workspace #workspace-nav' : '.app-shell > #workspace-nav').isVisible(), true);
      await ensureSidebarClosed(page);
      await page.locator('#nav-inbox').click();
      await page.locator('#inbox-panel').waitFor();
      assert.equal(await page.locator('.app-shell > #workspace-nav').isVisible(), true);
      await page.locator('#nav-rooms').click();
      if (await page.locator('#account-rooms-panel').isVisible()) await page.locator('#account-rooms-list button').first().click();
      await page.locator('#main').waitFor();
      await ensureSidebarClosed(page);
    }
    await page.locator('#message-input').fill('Keep this draft while I inspect the room');
    await page.locator('#session-menu-button').click();
    assert.equal(await page.locator('#signout-button').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'session-menu-button');
    await ensureSidebarOpen(page);
    await page.locator('#room-actions-open').click();
    await page.locator('#room-actions-dialog').waitFor();
    await page.keyboard.press('Escape');
    await ensureSidebarClosed(page);
    await openSettings(page); await closeSettings(page);
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep this draft while I inspect the room');
    mkdirSync('test-results/layout', { recursive: true });
    await page.screenshot({ path: `test-results/layout/room-${width}${account ? "-account" : ""}.png` });
    await page.locator('#new-work-button').click();
    await page.locator('#work-dialog').waitFor();
    assert.equal(await page.locator('#work-options').evaluate(e => e.open), false);
    await page.screenshot({ path: `test-results/layout/work-${width}${account ? "-account" : ""}.png` });
    await page.locator('#cancel-work-button').click();
    await page.locator('#message-input').fill('');
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    const composerControls = await page.locator('.composer-row > button').evaluateAll(buttons => buttons.filter(button => !button.hidden).map(button => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, scrollWidth: button.scrollWidth, clientWidth: button.clientWidth };
    }));
    for (const [index, box] of composerControls.entries()) {
      assert.ok(box.left >= 0 && box.right <= width + 1, 'composer action stays in viewport at large text');
      assert.ok(box.width >= 24 && box.height >= 24, 'composer action remains usable at large text');
      assert.ok(box.scrollWidth <= box.clientWidth + 1, 'composer action label fits its button');
      if (index) assert.ok(composerControls[index - 1].right <= box.left || composerControls[index - 1].bottom <= box.top, 'composer actions do not overlap at large text');
    }
    const overflow = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map(node => {
        const r = node.getBoundingClientRect();
        return `${node.id || node.className || node.tagName} right=${Math.round(r.right)} w=${Math.round(r.width)}`;
      });
      return { ok: document.documentElement.scrollWidth <= innerWidth + 1, scroll: document.documentElement.scrollWidth, inner: innerWidth, nodes };
    });
    assert.equal(overflow.ok, true, `large text reflows without horizontal overflow (scroll ${overflow.scroll} inner ${overflow.inner}${overflow.nodes.length ? `; ${overflow.nodes.join("; ")}` : ""})`);
    await page.evaluate(() => document.documentElement.style.fontSize = '');
    await page.locator('#session-menu-button').click();
    await page.locator('#signout-button').click();
    await page.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.app-shell > .topbar').isVisible(), true);
    assert.deepEqual(errors, []);
  });
}
