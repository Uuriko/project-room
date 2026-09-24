// Synthetic user journeys: no human-study outcomes or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { fillAccessKey } from "./auth-signin.mjs";
import { openSearch, openSettings } from "./room-chrome.mjs";

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
for (const touch of [false, true]) test(`release polish ${touch ? 'touch' : 'desktop'}: quiet controls, stable reading and usable History`, { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture(), server = createRoomServer({ store: fixture.store, streamInterval: 30 });
  // Force the tie that previously made two render paths move the same card.
  const recordedAt = Date.parse(fixture.store.room("commons").state.workItems["test-handoff"].updatedAt);
  fixture.store.now = () => recordedAt;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await fillAccessKey(page, fixture.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#clear-search').isVisible(), false);
  const layout = await page.evaluate(() => {
    const header = document.querySelector('.topbar').getBoundingClientRect();
    const composer = document.querySelector('#message-form').getBoundingClientRect();
    return { headerTop: header.top, composerBottom: composer.bottom, height: innerHeight,
      width: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  assert.ok(layout.headerTop >= 0 && layout.composerBottom <= layout.height + 1, 'header and composer fit together in the viewport');
  assert.ok(layout.width <= layout.viewport + 1, 'the shell never needs horizontal scrolling');
  assert.equal(await page.locator('#message-count, #people-hint, #people-wake-hint').count(), 0, 'redundant counters and instructions were removed');
  assert.equal(await page.locator('#recipe-preview-toggle').isVisible(), false, 'diagnostic tools do not crowd the conversation');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/redesign-${touch ? 'touch' : 'desktop'}-conversation.png` });
  const message = page.locator('[data-message-record-id="test-welcome"]');
  const HEART = "\u2764\uFE0F";
  assert.equal(await message.locator(`[data-reaction="${HEART}"]`).count(), 0, 'unused reactions stay out of sight until added');
  await message.locator('summary[aria-label="More actions for this message"]').click();
  await message.locator('button[data-message-action="add-reaction"]').click();
  await page.locator(`#reaction-sheet [data-reaction="${HEART}"]`).first().click();
  await page.locator('#reaction-sheet').waitFor({ state: "hidden" });
  await page.waitForFunction(glyph => document.querySelector(`[data-message-record-id="test-welcome"] [data-reaction="${glyph}"]`).getAttribute('aria-pressed') === 'true', HEART);
  assert.equal(await page.locator('#thread-bar').isVisible(), false, 'reacting does not switch the conversation');
  assert.match(await message.locator(`[data-reaction="${HEART}"]`).getAttribute('aria-label'), /, 1$/);
  assert.equal(await message.locator(`[data-reaction="${HEART}"].used`).count(), 1, 'a used reaction stays visibly marked');

  await openSearch(page);
  await page.locator('#message-search').fill('agenda');
  assert.equal(await page.locator('#clear-search').isVisible(), true);
  assert.equal(await page.locator('#composer-options').count(), 0);
  await settle(page);
  await page.evaluate(() => {
    window.searchMutations = 0;
    new MutationObserver(() => window.searchMutations++).observe(document.querySelector('#search-count'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#message-input').fill('Keep this draft while the room changes.');
  const work = page.locator('[data-work-record-id="test-handoff"]');
  await work.locator('.work-details > summary').click();
  const selection = await work.locator('.definition').evaluate(el => {
    window.retainedWork = el.closest('[data-work-record-id]');
    const range = document.createRange(); range.selectNodeContents(el);
    const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
    return selected.toString();
  });
  const posted = fixture.store.command(fixture.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'message.posted', data: { messageId: 'release-update', body: 'A quiet unrelated update.' } });
  await page.waitForFunction(sequence => document.querySelector('#event-count').textContent === String(sequence), posted.sequence);
  await settle(page);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selection);
  assert.equal(await page.evaluate(() => window.retainedWork === document.querySelector('[data-work-record-id="test-handoff"]')), true);
  assert.equal(await page.evaluate(() => window.searchMutations), 0);
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#clear-search').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-search');
  await work.locator('.work-details > summary').click();
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/release-polish-${touch ? 'touch' : 'desktop'}.png` });

  await openSettings(page, 'record-panel');
  const first = page.locator('#event-list li').first();
  await first.focus();
  await first.evaluate(el => { window.retainedHistory = el; });
  const refreshed = page.waitForResponse(response => /\/api\/rooms\/commons$/.test(response.url()) && response.request().method() === 'GET');
  await page.locator('#refresh-button').evaluate(button => button.click());
  await refreshed; await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement === window.retainedHistory && window.retainedHistory.isConnected), true);
  assert.equal(await first.evaluate(el => {
    const boxes = [...el.children].map(child => child.getBoundingClientRect());
    return boxes.every((box, i) => !i || box.top >= boxes[i - 1].bottom - 1);
  }), true, 'History fields form readable non-overlapping rows');
  await page.screenshot({ path: `test-results/release-history-${touch ? 'touch' : 'desktop'}.png` });
  assert.deepEqual(errors, []);
});
