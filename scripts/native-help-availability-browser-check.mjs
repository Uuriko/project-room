/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { openSearch } from './room-chrome.mjs';

for (const width of [390, 1280]) test(`native help has no controls or stale action dialog at ${width}px`, { timeout: 30000 }, async t => {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), { representation: 'normalized-current-v1' });
  const key = store.issueAccessKey('commons', 'owner'), workItemId = 'native-help-task';
  store.command(key, 'commons', { id: 'propose', type: 'work.proposed', data: {
    workItemId, title: 'Native help task', definitionOfDone: 'One local result', accountableMemberId: 'owner', mode: 'read'
  } });
  store.command(key, 'commons', { id: 'accept', type: 'work.accepted', data: { workItemId, expectedRevision: 0 } });
  const session = store.createSession(key), before = store.headSequence('commons');
  const server = createRoomServer({ store, streamInterval: 100 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
  });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies([{ name: 'room_session', value: session.token, url: origin }]);
  const page = await context.newPage(), errors = [], commands = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/commands')) commands.push(request.postDataJSON());
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/?room=commons');
  await page.locator('#main:not([hidden])').waitFor();
  await openSearch(page);
  await page.locator('#message-search').fill('Native help task');
  await page.locator(`#search-list [data-open-work="${workItemId}"]`).click();
  const card = page.locator(`[data-work-record-id="${workItemId}"]`);
  await card.waitFor();
  assert.equal(await card.locator('[data-action=help], [data-action=end-help], [data-action*=offer]').count(), 0);
  // A previously rendered action must not reopen a now-unsupported dialog or
  // reach submission through the actual delegated click handler.
  for (const action of ['help', 'end-help', 'offer-help', 'select-offer', 'decline-offer', 'withdraw-offer', 'release-offer']) {
    await page.evaluate(({ action, workItemId }) => {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.action = action; button.dataset.workId = workItemId;
      button.id = 'stale-help-action'; button.textContent = 'Stale action';
      document.querySelector('#message-list').append(button);
    }, { action, workItemId });
    await page.locator('#stale-help-action').click();
    assert.equal(await page.locator('#action-dialog').isVisible(), false, action);
    await page.locator('#stale-help-action').evaluate(button => button.remove());
  }
  assert.deepEqual(commands, []);
  assert.equal(store.headSequence('commons'), before);
  assert.deepEqual(errors, []);
});
