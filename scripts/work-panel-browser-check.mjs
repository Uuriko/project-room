// Real-browser check for the Work panel (room-full phase 1).
// node --test scripts/work-panel-browser-check.mjs   (needs Playwright's Chromium)
// WORK_PANEL_SHOTS=dir also saves desktop and phone screenshots there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
import { makeTestSigner } from './helpers/signed-evidence.mjs';

test('owner sees work that needs them, work in progress, and can open the review form from the panel', { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  const send = (key, type, data) => f.store.command(key, 'commons', { id: crypto.randomUUID(), type, data });
  send(f.keys.owner, 'work.proposed', { workItemId: 'invite-flow', title: 'Ship the invite flow', definitionOfDone: 'Guests can join from a link',
    accountableMemberId: 'producer', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: 'owner' });
  send(f.keys.producer, 'work.accepted', { workItemId: 'invite-flow', expectedRevision: 0 });
  send(f.keys.producer, 'work.started', { workItemId: 'invite-flow', expectedRevision: 1 });
  send(f.keys.producer, 'work.completed', { workItemId: 'invite-flow', expectedRevision: 2, summary: 'Invite links work and expire cleanly',
    evidenceUrl: 'https://example.invalid/pr/1760', evidenceVersion: 'v1', producerId: 'producer', checksClaimed: ['42/42 tests', 'Staging passed'], nextAction: 'Decide', signedEvidence: makeTestSigner(f.store)() });
  send(f.keys.owner, 'work.proposed', { workItemId: 'style-404', title: 'Style the 404 page', definitionOfDone: 'Uses room tokens',
    accountableMemberId: 'producer', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false });
  send(f.keys.producer, 'work.accepted', { workItemId: 'style-404', expectedRevision: 0 });
  send(f.keys.producer, 'work.started', { workItemId: 'style-404', expectedRevision: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const shots = process.env.WORK_PANEL_SHOTS; if (shots) mkdirSync(shots, { recursive: true });
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  await page.locator('#main').waitFor({ state: 'visible' });
  // Wide screen with work waiting: the panel opens on its own.
  await page.locator('#work-panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /^1 needs you · [0-9]+ in progress$/.test(document.querySelector('#work-panel-summary').textContent));
  assert.equal(await page.locator('#work-panel-count').textContent(), '1');
  const needs = page.locator('.wp-section[aria-label="Needs you"] .wp-card');
  assert.equal(await needs.count(), 1);
  assert.match(await needs.first().textContent(), /Ship the invite flow[\s\S]*Test producer[\s\S]*agent[\s\S]*42\/42 tests/);
  assert.match(await page.locator('.wp-section[aria-label="In progress"]').textContent(), /Style the 404 page[\s\S]*Working/);
  const grid = await page.locator('#main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(grid, 3, 'the panel is a third column on a wide screen');
  // With the panel open, the conversation's work card is a compact row: action beside the title.
  const row = page.locator('.timeline .work-card[data-work-record-id="invite-flow"]');
  const [title, action] = await Promise.all([row.locator('h3').boundingBox(), row.locator('.work-actions').boundingBox()]);
  assert.ok(action.x > title.x + title.width - 1, 'the action sits to the right of the title');
  assert.equal(await row.locator('> .portable-actions').isVisible().catch(() => false), false);
  assert.match(await page.locator('.wp-catchup').textContent(), /Waiting on you: Ship the invite flow\./);
  // Presence strip under the room title: you first, then the room's members.
  await page.locator('#presence-strip').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#presence-strip .ps-chip').first().locator('.ps-name').textContent(), 'You');
  assert.match(await page.locator('#presence-strip').textContent(), /Test producer/);
  // The owner attention card no longer repeats the decision the panel shows.
  assert.equal(await page.locator('#needs-attention').isVisible(), false);
  if (shots) await page.screenshot({ path: join(shots, 'work-panel-desktop.png') });
  // The primary button opens the existing decision form for that work.
  await needs.first().locator('[data-wp-action="decide"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open]')].length > 0);
  await page.keyboard.press('Escape');
  // Close and reopen from the header; the choice sticks for this browser.
  await page.locator('[data-wp-close]').click();
  assert.equal(await page.locator('#work-panel').isVisible(), false);
  assert.equal(await page.locator('#work-panel-toggle').getAttribute('aria-expanded'), 'false');
  await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#work-panel-toggle').hidden);
  assert.equal(await page.locator('#work-panel').isVisible(), false, 'closed stays closed after reload');
  await page.waitForFunction(() => document.querySelector('#needs-attention .attention-decision') !== null);
  assert.equal(await page.locator('#needs-attention').isVisible(), true, 'with the panel closed the attention card is back');
  await page.locator('#work-panel-toggle').click();
  await page.locator('#work-panel').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'work-panel-title', 'opening moves focus into the panel');

  // A live update redraws the panel; the focused button keeps focus and still works from the keyboard.
  await needs.first().locator('[data-wp-action="decide"]').focus();
  const before = await page.locator('#work-panel-summary').textContent();
  send(f.keys.owner, 'work.proposed', { workItemId: 'live-update', title: 'Arrives while you are reading', definitionOfDone: 'Shows up',
    accountableMemberId: 'producer', mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false });
  await page.waitForFunction(text => document.querySelector('#work-panel-summary').textContent !== text, before);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.wpAction), 'decide', 'focus survives the redraw');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open]')].length > 0);
  await page.keyboard.press('Escape');

  // Phone: a drawer, closed until asked for.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } }), small = await phone.newPage();
  small.on('pageerror', e => errors.push(e.message));
  await small.goto(origin); await signInFixture(small, f.keys.owner);
  await small.locator('#main').waitFor({ state: 'visible' });
  await small.waitForFunction(() => !document.querySelector('#work-panel-toggle').hidden);
  assert.equal(await small.locator('#work-panel').isVisible(), false);
  await small.locator('#work-panel-toggle').focus();
  await small.keyboard.press('Enter');
  await small.locator('#work-panel').waitFor({ state: 'visible' });
  assert.equal(await small.evaluate(() => document.activeElement?.id), 'work-panel-title', 'keyboard opening lands inside the drawer');
  await small.keyboard.press('Escape');
  assert.equal(await small.locator('#work-panel').isVisible(), false);
  assert.equal(await small.evaluate(() => document.activeElement?.id), 'work-panel-toggle', 'Escape returns focus to the Work button');
  await small.keyboard.press('Enter');
  await small.locator('#work-panel').waitFor({ state: 'visible' });
  const box = await small.locator('#work-panel').boundingBox();
  assert.ok(box.width <= 390, 'the drawer fits the phone');
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
  if (shots) await small.screenshot({ path: join(shots, 'work-panel-phone.png') });
  await small.locator('.wp-card [data-open-work="style-404"]').click();
  assert.equal(await small.locator('#work-panel').isVisible(), false, 'following a link closes the drawer');

  // A guest with no work sees an empty, quiet panel when they open it.
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), guest = await guestContext.newPage();
  guest.on('pageerror', e => errors.push(e.message));
  await guest.goto(origin); await signInFixture(guest, f.keys.guest);
  await guest.locator('#main').waitFor({ state: 'visible' });
  await guest.waitForFunction(() => !document.querySelector('#work-panel-toggle').hidden);
  assert.equal(await guest.locator('#work-panel-count').isHidden(), true);
  await guest.locator('#work-panel-toggle').click();
  assert.match(await guest.locator('#work-panel-body').textContent(), /Nothing is waiting on you\./);
  assert.equal(await guest.locator('[data-wp-action]').count(), 0, 'a guest without permissions gets no action buttons');

  assert.deepEqual(errors, []);
});
