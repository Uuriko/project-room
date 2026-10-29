// Disposable local rooms; no production messages or accounts are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { signInFixture } from './auth-signin.mjs';

for (const width of [1440, 320]) test(`direct conversations ${width}: keyboard navigation, audience, drafts and reload`, { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-direct-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  const send = (key, type, data) => store.command(key, 'commons', { id: crypto.randomUUID(), type, data });
  for (const id of ['alice', 'bob']) send(owner, T.MEMBER_ADDED, { memberId: id, displayName: id === 'alice' ? 'Alice' : 'Bob', kind: 'human', permissions: [] });
  const alice = store.issueAccessKey('commons', 'alice');
  const bob = store.issueAccessKey('commons', 'bob');
  send(alice, T.MESSAGE_POSTED, { messageId: 'alice-private', body: 'Private hello', toMemberId: 'owner' });
  if (width === 1440) {
    store.roomFlood = { consume() {} };
    for (let i = 0; i < 60; i++) send(alice, T.MESSAGE_POSTED, { messageId: `private-history-${i}`, body: `Earlier private note ${i}`, toMemberId: "owner" });
    for (let i = 0; i < 120; i++) send(owner, T.MESSAGE_POSTED, { messageId: `busy-${i}`, body: `Unrelated public discussion ${i}` });
  }
  send(owner, T.MESSAGE_POSTED, { messageId: 'public-topic', body: 'Public room topic' });
  const server = createRoomServer({ store, streamInterval: 50, credentialReadBurst: 600, credentialWriteBurst: 600 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error('browser error:', e.message); });
  page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, owner);
  const input = page.locator('#message-input');
  await page.locator('#message-list').getByText('Public room topic', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-list').getByText('Private hello', { exact: true }).count(), 0);
  await page.locator('#direct-message-list [data-direct-member="alice"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#message-list').getByText('Private hello', { exact: true }).count(), 0, 'directory discovery does not load the private body');
  const historyReads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/\/(conversation|messages)$/.test(url.pathname)) historyReads.push(url);
  });
  if (width === 1440) {
    await page.evaluate(() => { location.hash = '#pr-record/message/alice-private'; });
    await page.waitForFunction(() => document.activeElement?.dataset?.messageRecordId === 'alice-private');
    assert.ok(historyReads.some(url => url.searchParams.get('messageId') === 'alice-private'));
    assert.equal(historyReads.some(url => !url.searchParams.has('messageId') && !url.searchParams.has('peerMemberId')), false);
    await page.locator('#channel-list [data-channel="general"]').click();
    await page.evaluate(() => history.replaceState(null, '', location.pathname));
    historyReads.length = 0;
  }
  await input.fill('Public draft');
  const open = async name => {
    await page.locator('#composer-options-toggle').press('Enter');
    await page.getByRole('button', { name: 'Direct message…', exact: true }).press('Enter');
    await page.locator('#new-direct-search').fill(name);
    await page.locator('#new-direct-people').getByRole('button', { name, exact: true }).press('Enter');
    await page.waitForFunction(name => document.querySelector('#conversation-title').textContent === name, name);
  };
  await open('Alice');
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('#composer-toolbar').isVisible(), false);
  assert.equal(await page.locator('#message-list').getByText('Public room topic', { exact: true }).count(), 0);
  if (width === 1440) await page.locator('[data-timeline-earlier]').click();
  await page.locator('#message-list').getByText('Private hello', { exact: true }).waitFor();
  assert.ok(historyReads.some(url => url.pathname.endsWith('/conversation') && url.searchParams.get('peerMemberId') === 'alice'));
  assert.equal(historyReads.some(url => url.pathname.endsWith('/messages') || !url.searchParams.has('peerMemberId')), false, 'opening an old DM never fills unrelated room history');
  // Scrolling a private conversation must never activate the public-history fill.
  await page.locator('#message-list').evaluate(list => {
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(historyReads.some(url => !url.searchParams.has('peerMemberId')), false, 'private scrolling must not fetch unrelated history');
  if (width === 1440) {
    await page.locator('#message-list [data-message-record-id="private-history-0"]').waitFor();
    const updated = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/conversation') && url.searchParams.get('peerMemberId') === 'alice' && url.searchParams.has('since');
    });
    send(owner, T.MESSAGE_POSTED, { messageId: 'unrelated-live-update', body: 'Public update while reading private history' });
    await updated;
    await page.waitForFunction(() => !document.querySelector('#message-list [data-timeline-earlier]')?.disabled);
    assert.equal(await page.locator('#message-list [data-message-record-id="private-history-0"]').count(), 1, 'unrelated public activity must not remove the private page being read');
  }
  await input.fill('Alice draft');
  await open('Bob');
  assert.equal(await input.inputValue(), '');
  await input.fill('Bob draft');
  await open('Alice');
  assert.equal(await input.inputValue(), 'Alice draft');
  const attempts = [];
  await page.route('**/api/rooms/commons/commands', async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#message-input').disabled && document.querySelector('#composer-status').classList.contains('error'));
  assert.equal(await input.inputValue(), 'Alice draft');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('#message-input').value === '');
  const sent = store.room('commons').state.messages.find(m => m.body === 'Alice draft');
  assert.equal(sent.toMemberId, 'alice');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].id, attempts[1].id);
  assert.deepEqual(attempts[0].data, attempts[1].data);
  assert.equal(attempts[1].data.toMemberId, 'alice');
  assert.equal(store.room('commons').state.messages.filter(m => m.body === 'Alice draft').length, 1);
  await page.unroute('**/api/rooms/commons/commands');
  assert.equal(await page.locator('#conversation-title').innerText(), 'Alice');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#conversation-title').textContent === 'Alice');
  assert.equal(await input.inputValue(), '');
  await input.fill('Alice after send');
  if (width === 1440) await page.locator('[data-timeline-earlier]').click();
  await page.locator('[data-message-record-id="alice-private"] [data-message-action="reply"]').click();
  assert.equal(await page.locator('#message-to-select').inputValue(), 'alice');
  await input.fill('Reply only to Alice');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelector('#message-input').value === '');
  const replied = store.room('commons').state.messages.find(m => m.body === 'Reply only to Alice');
  assert.equal(replied.toMemberId, 'alice');
  assert.equal(replied.replyToId, 'alice-private');
  await page.locator('#thread-back').click();
  assert.equal(await input.inputValue(), 'Alice after send');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#message-input').value === 'Alice after send');
  assert.equal(await page.locator('#conversation-title').innerText(), 'Alice');
  if (width === 320) await page.locator('#sidebar-toggle').click();
  await page.locator('#channel-list [data-channel="general"]').click();
  if (width === 320 && await page.locator('#sidebar-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#sidebar-toggle').click();
  assert.equal(await input.inputValue(), 'Public draft');
  assert.equal(await page.locator('#message-list').getByText('Alice draft', { exact: true }).count(), 0);
  await open('Bob');
  assert.equal(await input.inputValue(), 'Bob draft');
  await page.locator('#message-list [data-empty-write]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#channel-list [aria-current="page"]').count(), 0, 'public channel is not selected inside a private conversation');
  if (width === 320) {
    const composer = await page.locator('#message-form').boundingBox();
    assert.ok(composer && composer.y + composer.height > 800, 'tall narrow windows should use the available height');
  }
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/direct-conversation-${width}.png` });
  if (width === 320) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.setViewportSize({ width, height: 420 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      const sendButton = page.locator('#message-form button[type="submit"]');
      await sendButton.scrollIntoViewIfNeeded();
      const target = await sendButton.boundingBox();
      assert.ok(target && target.y >= 0 && target.y + target.height <= 421, 'short windows with enlarged text keep Send reachable');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'enlarged text must not create horizontal scrolling');
      await page.screenshot({ path: `test-results/direct-conversation-short-large-${theme}.png` });
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await page.setViewportSize({ width, height: 900 });
    }
  }
  for (const [key, canRead] of [[alice, true], [bob, false]]) {
    const context = await browser.newContext();
    const peerPage = await context.newPage();
    await peerPage.goto(page.url());
    await signInFixture(peerPage, key);
    if (canRead) {
      await peerPage.locator('#direct-message-list [data-direct-member="owner"]').click();
      await peerPage.locator('#message-list').getByText('Reply only to Alice', { exact: true }).waitFor();
    } else {
      assert.equal(await peerPage.locator('#message-list').getByText('Reply only to Alice', { exact: true }).count(), 0);
      const response = await context.request.get(new URL('/api/rooms/commons/conversation', page.url()).href);
      const history = await response.json();
      assert.equal(history.messages.some(message => message.id === replied.id || message.id === sent.id), false);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
});
