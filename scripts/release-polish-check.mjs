// Synthetic user journeys: no human-study outcomes or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
for (const touch of [false, true]) test(`release polish ${touch ? 'touch' : 'desktop'}: quiet controls, stable reading and usable History`, { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture(), server = createRoomServer({ store: fixture.store, streamInterval: 30 });
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
  await page.locator('#access-key').fill(fixture.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#clear-search').isVisible(), false);
  const message = page.locator('[data-message-record-id="test-welcome"]');
  assert.equal(await message.locator('[data-reaction="heart"]').isVisible(), true, 'reaction pills stay visible without a disclosure');
  await message.locator('[data-reaction="heart"]').click();
  await page.waitForFunction(() => document.querySelector('[data-message-record-id="test-welcome"] [data-reaction="heart"]').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#thread-bar').isVisible(), false, 'reacting does not switch the conversation');
  assert.match(await message.locator('[data-reaction="heart"]').getAttribute('aria-label'), /, 1$/);
  assert.equal(await message.locator('[data-reaction="heart"].used').count(), 1, 'a used reaction stays visibly marked');

  await page.locator('#message-search').fill('agenda');
  assert.equal(await page.locator('#clear-search').isVisible(), true);
  await page.locator('#composer-options > summary').click();
  await page.locator('#remember-drafts').check();
  await settle(page);
  await page.evaluate(() => {
    window.recoveryMutations = 0; window.searchMutations = 0;
    new MutationObserver(() => window.recoveryMutations++).observe(document.querySelector('#draft-recovery-status'), { childList: true, characterData: true, subtree: true });
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
  assert.deepEqual(await page.evaluate(() => [window.recoveryMutations, window.searchMutations]), [0, 0]);
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#clear-search').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-search');
  await page.locator('#composer-options > summary').click();
  await work.locator('.work-details > summary').click();
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/release-polish-${touch ? 'touch' : 'desktop'}.png` });

  await page.locator('#record-panel > summary').click();
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
