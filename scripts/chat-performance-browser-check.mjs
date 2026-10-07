import { openMemberProfile } from "./room-chrome.mjs";
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
import { openSettings, clickChrome } from './room-chrome.mjs';
import { signInFixtureInPlace } from './in-place-fixture-signin.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { admitHistoricalMember } from './unstamped-member.mjs';

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

test('snapshot labels update duplicates while preserving focus and selection, and late old-room data cannot replace new labels', { timeout: 45000 }, async t => {
  const f = createAcceptanceFixture(), other = initialRoom('other', 'owner');
  other[0].data.title = 'Another private room'; other[1].data.displayName = 'Another private owner';
  f.store.initialize(other); f.store.createAccount('other-private-account'); f.store.bindHumanAccount('other', 'owner', 'other-private-account');
  const otherKey = f.store.issueAccessKey('other', 'owner');
  f.store.command(otherKey, 'other', { id: 'other-message', type: 'message.posted', data: { messageId: 'other-message', body: 'New room private content' } });
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  let release; t.after(async () => { release?.(); await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  const original = page.locator('[data-message-record-id="test-welcome"]');
  assert.equal(await original.locator('.message-meta strong').textContent(), 'Room owner');
  const profile = page.locator('[data-member-record-id="owner"] .member-profile');
  await openMemberProfile(page, 'owner');
  await page.evaluate(() => {
    const body = document.querySelector('[data-message-record-id="test-welcome"] .message-body');
    globalThis.retainedAuditBody = body;
    const range = document.createRange(); range.selectNodeContents(body); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    globalThis.auditSelectedText = selection.toString();
    document.querySelector('[data-member-record-id="owner"] .member-profile > summary').focus();
  });
  admitHistoricalMember(f.store, 'commons', 'owner', { memberId: 'duplicate-owner', displayName: ' room OWNER ', kind: 'human', permissions: [] });
  await original.locator('.message-meta strong').filter({ hasText: /^Room owner \(owner\)$/ }).waitFor();
  assert.equal(await profile.evaluate(el => el.open), true);
  const preserved = await page.evaluate(() => ({ body: globalThis.retainedAuditBody === document.querySelector('[data-message-record-id="test-welcome"] .message-body'), selected: getSelection().toString() === globalThis.auditSelectedText, focus: document.activeElement?.dataset.focusKey }));
  assert.deepEqual(preserved, { body: true, selected: true, focus: 'member-profile:owner' });
  let captured, delivered;
  const held = new Promise(resolve => captured = resolve), unblock = new Promise(resolve => release = resolve), finished = new Promise(resolve => delivered = resolve);
  await page.route(/\/api\/rooms\/commons(?:\?|$)/, async route => {
    const response = await route.fetch(); captured(); await unblock; await route.fulfill({ response }); delivered();
  });
  f.store.command(f.keys.owner, 'commons', { id: 'held-private-old', type: 'message.posted', data: { messageId: 'held-private-old', body: 'Old private message must not return' } });
  await held;
  await clickChrome(page, '#signout-button'); await page.locator('#auth-panel').waitFor();
  assert.equal(await page.locator('#presence-list').textContent(), '');
  await signInFixtureInPlace(page, f.store, otherKey, 'other');
  await page.locator('[data-message-record-id="other-message"]').waitFor();
  release(); await finished;
  assert.equal(await page.locator('[data-message-record-id="other-message"] .message-meta strong').textContent(), 'Another private owner');
  assert.equal(await page.locator('#identity-label').textContent(), 'Another private owner');
  assert.equal(await page.locator('[data-message-record-id="test-welcome"]').count(), 0);
  assert.equal(await page.locator('[data-message-record-id="held-private-old"]').count(), 0);
  assert.equal(await page.locator('#presence-list').textContent().then(text => text.includes('Room owner')), false);
  assert.deepEqual(errors, []);
});
