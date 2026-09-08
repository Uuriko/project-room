// Simulated local people. Search must not submit, acknowledge or create work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { auditRecovery } from '../server/recovery.mjs';

for (const touch of [false, true]) test(`work search ${touch ? 'touch' : 'desktop'}: return to outcomes without losing context`, { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (type, data) => f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type, data });
  const propose = (id, title, done = 'Name the person and next step.') => send('work.proposed', { workItemId: id, title,
    definitionOfDone: done, accountableMemberId: 'owner', independentVerificationRequired: false, ownerDecisionRequired: false });
  const pair = 'search:same-id';
  propose(pair, 'Orbit <b>agenda</b>', 'Gather the telescope notes.');
  send('message.posted', { messageId: pair, body: 'Orbit discussion from the same ID.' });
  propose('finished', 'Previous Orbit outcome');
  const mutate = (type, extra = {}) => send(type, { workItemId: 'finished', expectedRevision: f.store.room('commons').state.workItems.finished.revision, ...extra });
  mutate('work.accepted');
  const finish = summary => mutate('work.completed', { summary, evidenceUrl: 'https://example.invalid/not-fetched',
    evidenceVersion: crypto.randomUUID(), producerId: 'owner', nextAction: 'Discuss any follow-up.' });
  finish('The handoff-only finding is ready.');
  for (let index = 0; index < 27; index++) propose(`bounded-${index}`, `Bounds fixture ${index}`);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#access-key').fill(f.keys.owner); await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#main').waitFor({ state: 'visible' });
  const search = page.locator('#message-search'), hits = page.locator('#search-list');
  const workHit = id => hits.locator(`[data-open-work="${id}"]`);
  const before = auditRecovery(f.store).dataSha256;
  await page.locator('#message-input').fill('Keep my unsent thought.');
  await search.fill('Orbit');
  assert.equal(await page.locator('#search-count').textContent(), '3 matches in this room');
  assert.equal(await hits.locator('[data-open-work]').count(), 2);
  assert.equal(await hits.locator('a').first().getAttribute('data-open-work'), pair, 'open work precedes finished work');
  assert.equal(await hits.locator('b').count(), 0, 'titles are literal text');
  const target = workHit(pair);
  await target.focus(); await page.keyboard.press('Enter');
  const card = page.locator('[data-work-record-id]').filter({ has: page.locator('h3', { hasText: 'Orbit <b>agenda</b>' }) });
  assert.equal(await card.locator('.work-details').evaluate(node => node.open), true);
  assert.equal(await card.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#message-input').inputValue(), 'Keep my unsent thought.');
  assert.equal(auditRecovery(f.store).dataSha256, before, 'search/navigation do not change any Room table');

  // Live updates preserve focus by both record kind and ID, not ID alone.
  const messageHit = hits.locator('[data-open-message]'); await messageHit.focus();
  const posted = propose('newer', 'Orbit planning follow-up');
  await page.waitForFunction(seq => document.querySelector('#event-count').textContent === String(seq), posted.sequence);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.searchKey), `message:${pair}`);
  await target.focus();
  const added = send('message.posted', { messageId: 'orbit-live', body: 'Orbit follow-up in discussion.' });
  await page.waitForFunction(seq => document.querySelector('#event-count').textContent === String(seq), added.sequence);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.searchKey), `work:${pair}`);
  await page.locator('#message-input').focus();
  const next = send('message.posted', { messageId: 'orbit-live-again', body: 'Orbit follow-up again.' });
  await page.waitForFunction(seq => document.querySelector('#event-count').textContent === String(seq), next.sequence);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-input');
  assert.equal(await page.locator('#message-input').inputValue(), 'Keep my unsent thought.');
  await search.scrollIntoViewIfNeeded();
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/work-search-${touch ? 'touch' : 'desktop'}-mixed.png` });

  await search.fill('handoff-only');
  assert.equal(await hits.locator('a').count(), 1);
  assert.match(await hits.locator('small').textContent(), /Completed/);
  await hits.locator('a').click();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.workRecordId), 'finished');
  await hits.locator('a').focus();
  mutate('work.blocked', { reason: 'Revise the stored finding.', nextAction: 'Prepare corrected text.' });
  mutate('work.blocker_resolved', { resolution: 'Corrected wording prepared.' });
  const replacement = finish('Replacement finding is ready.');
  await page.waitForFunction(seq => document.querySelector('#event-count').textContent === String(seq), replacement.sequence);
  assert.equal(await hits.locator('a').count(), 0, 'old completion text is not a current search result');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-search', 'removed focused hit returns to search');

  await search.fill('Bounds');
  assert.equal(await hits.locator('[data-open-work]').count(), 25);
  assert.equal(await page.locator('#search-count').textContent(), '27 matches · 25 shown in this room');
  await search.fill('telescope');
  assert.equal(await hits.locator('[data-open-work]').count(), 1);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await search.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await hits.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  assert.ok((await hits.locator('a').boundingBox()).height >= 44);
  await page.screenshot({ path: `test-results/work-search-${touch ? 'touch' : 'desktop'}-large.png` });
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#search-results').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-search');
  await search.fill('Orbit');
  await page.locator('#message-input').fill('');
  await page.locator('#signout-button').click(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await search.inputValue(), ''); assert.equal(await hits.textContent(), '');
  assert.equal(f.store.db.prepare('SELECT sequence FROM cursors WHERE room_id=? AND member_id=?').get('commons', 'owner')?.sequence ?? 0, 0);
  assert.deepEqual(errors, []);
});
