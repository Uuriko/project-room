import { clickChrome } from "./room-chrome.mjs";
import { openComposerOptions } from "./room-chrome.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { contrastRatio } from '../src/design-tokens.js';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
import { ensureSidebarOpen, ensureSidebarClosed, openSettings, closeSettings } from './room-chrome.mjs';

for (const [width, account, height = 900] of [[1440, false], [390, false], [320, false], [1440, true], [390, true], [758, true, 470]]) {
  test(`conversation layout at ${width}x${height} (${account ? "account" : "room key"}) preserves navigation, drafts and usable controls`, { timeout: 60000 }, async t => {
    const fixture = createAcceptanceFixture();
    const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 500, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const accountId = fixture.store.accountForMember('commons', 'owner').id;
    fixture.store.completeOnboarding(accountId);
    const key = account ? fixture.store.issueAccountAccessKey(accountId) : fixture.keys.owner;
    await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
    await signInFixture(page, key);
    await page.locator('#main').waitFor({ state: 'visible' });
    await page.locator('.room-topbar #session-menu').waitFor();
    assert.equal(await page.locator('.app-shell > .topbar').isVisible(), false);
    for (const selector of ['#topbar-search-toggle', '#topbar-updates', '#room-more > summary', '#session-menu-button']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${selector} remains in viewport`);
      assert.ok(box.width >= 24 && box.height >= 24, `${selector} has a usable target`);
    }
    assert.ok(await page.locator('#conversation-title').boundingBox());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (account) {
      await ensureSidebarOpen(page);
      assert.equal(await page.locator('#sidebar-workspace #workspace-nav').isVisible(), true);
      await ensureSidebarClosed(page);
      await clickChrome(page, '#nav-rooms');
      await page.locator('#account-rooms-panel').waitFor();
      assert.equal(await page.locator('.app-shell > #workspace-nav').isVisible(), true);
      await page.locator('#nav-rooms').click();
      if (await page.locator('#account-rooms-panel').isVisible()) await page.locator('#account-rooms-list button').first().click();
      await page.locator('#main').waitFor();
      await ensureSidebarClosed(page);
    }
    // The <=20em accessibility layout deliberately allows document scrolling.
    if (width > 320) assert.ok(await page.locator('#main').evaluate(main => main.getBoundingClientRect().bottom <= innerHeight + 1), 'Room fits the window before focusing the composer');
    await page.locator('#message-input').fill('Keep this draft while I inspect the room');
    const send = page.locator('#message-form button[type="submit"]');
    await send.scrollIntoViewIfNeeded();
    assert.ok(await send.evaluate(button => {
      const box = button.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight && [box.top + 1, box.bottom - 1].every(y =>
        button.contains(document.elementFromPoint(box.x + box.width / 2, y)));
    }), 'Send is fully visible and not covered by workspace navigation');
    if (height < 500) {
      mkdirSync('test-results/layout', { recursive: true });
      await page.screenshot({ path: `test-results/layout/composer-${width}x${height}.png` });
    }
    await page.locator('#session-menu-button').click();
    assert.equal(await page.locator('#signout-button').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'session-menu-button');
    await ensureSidebarOpen(page);
    await clickChrome(page, '#room-actions-open');
    await page.locator('#room-actions-dialog').waitFor();
    await page.keyboard.press('Escape');
    await ensureSidebarClosed(page);
    await openSettings(page); await closeSettings(page);
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep this draft while I inspect the room');
    mkdirSync('test-results/layout', { recursive: true });
    await page.screenshot({ path: `test-results/layout/room-${width}${account ? "-account" : ""}.png` });
    await openComposerOptions(page); await page.locator('#new-work-button').click();
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

const hex = rgb => '#' + rgb.match(/\d+/g).slice(0, 3).map(x => Number(x).toString(16).padStart(2, '0')).join('');
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`conversation navigation ${width} ${theme}: readable, reachable and draft-preserving`, { timeout: 30000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 500, isMobile: width < 500 });
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${server.address().port}/?room=commons`);
    await signInFixture(page, f.store.issueAccountAccessKey(f.store.accountForMember('commons', 'owner').id));
    await page.locator('#main').waitFor({ state: 'visible' });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.locator('#message-input').fill('Keep my draft through navigation');
    assert.equal(await page.locator('#composer-hint').isVisible(), width >= 500);
    assert.equal(await page.locator('.app-shell > #workspace-nav').count(), 0, 'no redundant bottom navigation in a conversation');
    if (width < 500) {
      assert.equal(await page.locator('.app-shell').evaluate(node => parseFloat(getComputedStyle(node).paddingBottom)), 0);
      await page.locator('#sidebar-toggle').click();
    }
    const nav = page.locator('#sidebar-workspace #nav-rooms');
    const colors = await nav.evaluate(node => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    assert.ok(contrastRatio(hex(colors.foreground), hex(colors.background)) >= 4.5, 'normal navigation text meets AA contrast');
    const box = await nav.boundingBox(); assert.ok(box.height >= 44, 'navigation retains a touch-sized target');
    await nav.click();
    await page.locator('#account-rooms-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.app-shell > #workspace-nav').isVisible(), true, 'account navigation remains available');
    await page.locator('[data-account-room="commons"]').click();
    await page.locator('#main').waitFor({ state: 'visible' });
    if (width < 500) await page.keyboard.press('Escape');
    assert.equal(await page.locator('#message-input').inputValue(), 'Keep my draft through navigation');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#composer-options-toggle').click();
    assert.equal(await page.locator('#new-work-button').isVisible(), true);
    await page.locator('#composer-options-toggle').click();
    const send = page.locator('#message-form button[type="submit"]');
    assert.ok(await send.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'Send is not covered');
  });
}
