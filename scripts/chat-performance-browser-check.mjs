// Observable chat cost contract: ordinary arrivals leave historical DOM and
// hidden logs untouched and do not poll unchanged request-run subscriptions.
// Existing chat suites check focus/content, not redundant mutations or reads.
// Real Chromium + local server; no production hooks or timing threshold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
import { openSettings } from './room-chrome.mjs';

test('ordinary chat arrivals preserve historical DOM and fetch only changed request subscriptions', { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture({ dmConsent: true });
  let clock = Date.now();
  f.store.now = () => clock;
  const post = (actor, id, extra = {}) => {
    clock += 2100;
    return f.store.command(f.keys[actor], 'commons', { id, type: 'message.posted', data: {
      messageId: id, body: `Chat message ${id}`, ...extra
    } });
  };
  for (let i = 0; i < 60; i++) post('owner', `history-${i}`);
  post('owner', 'first-question', { toMemberId: 'producer', requestKind: 'reply' });
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; let runReads = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/request-runs')) runReads++; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  const initialRuns = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/request-runs'));
  await page.locator('[data-message-record-id="first-question"]').waitFor();
  await initialRuns;
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const stable = document.querySelector('[data-message-record-id="history-0"]');
    globalThis.chatCost = { stable, mutations: 0, hiddenLogMutations: 0 };
    new MutationObserver(rows => { globalThis.chatCost.mutations += rows.length; })
      .observe(stable, { attributes: true, childList: true, subtree: true, characterData: true });
    new MutationObserver(rows => { globalThis.chatCost.hiddenLogMutations += rows.length; })
      .observe(document.getElementById('event-list'), { childList: true, subtree: true });
  });
  const before = runReads;
  post('producer', 'ordinary-arrival');
  await page.locator('[data-message-record-id="ordinary-arrival"]').waitFor();
  await page.waitForTimeout(200);
  const cost = await page.evaluate(() => ({
    stableRetained: globalThis.chatCost.stable === document.querySelector('[data-message-record-id="history-0"]'),
    mutations: globalThis.chatCost.mutations,
    hiddenLogMutations: globalThis.chatCost.hiddenLogMutations
  }));
  assert.deepEqual(cost, { stableRetained: true, mutations: 0, hiddenLogMutations: 0 });
  assert.equal(runReads, before, 'unrelated chat must not re-read run state');
  const newRuns = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/request-runs'));
  const questionReceipt = post('owner', 'second-question', { toMemberId: 'producer', requestKind: 'reply' });
  await page.locator('[data-message-record-id="second-question"]').waitFor();
  await newRuns;
  assert.equal(runReads, before + 1, 'new request immediately refreshes run labels');
  await openSettings(page, 'record-panel');
  await page.locator(`#event-list [data-event-record-id="${questionReceipt.event.id}"]`).waitFor({ state: 'visible' });
  const visibleReceipt = post('producer', 'visible-record-arrival');
  await page.locator(`#event-list [data-event-record-id="${visibleReceipt.event.id}"]`).waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
});
