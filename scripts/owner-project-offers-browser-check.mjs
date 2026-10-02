import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { signInFixtureInPlace } from './in-place-fixture-signin.mjs';
import { createRoomServer } from '../server/http.mjs';
import { offerMinorUnits } from '../src/owner-project-offers-ui.js';
async function setup(t, { member = 'owner', mobile = false } = {}) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, assetRoot: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: mobile ? 320 : 1280, height: 900 }, isMobile: mobile, hasTouch: mobile }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); assert.deepEqual(errors, []); });
  await page.goto(`${origin}/?room=commons`); await signInFixtureInPlace(page, fixture.store, fixture.keys[member]);
  return { page, store: fixture.store, origin };
}
async function open(page) { await page.locator('#room-more > summary').click(); await page.locator('#owner-offers-open').click(); await page.locator('#owner-offers-dialog').waitFor({ state: 'visible' }); }
async function fill(page, { reward = 'credit' } = {}) {
  const form = page.locator('#owner-offer-form'); await form.locator('[name=title]').fill('Improve the welcome flow'); await form.locator('[name=summary]').fill('A reviewable contribution'); await form.locator('[name=criteria]').fill('Exact revision\nReproducible checks'); await form.locator('[name=reward]').selectOption(reward);
  if (reward !== 'unpaid') await form.locator('[name=amount]').fill(reward === 'USDC' ? '12.345678' : '12.50');
  await form.locator('[name=human]').selectOption('owner'); await form.locator('[name=submission]').fill('https://github.com/Uuriko/project-room/issues');
}
const saved = page => page.locator('#owner-offer-status').filter({ hasText: 'Draft saved' }).waitFor();
test('owner posts previews publishes and withdraws real fixed-credit terms without reserving credits', { timeout: 45000 }, async t => {
  const f = await setup(t); const before = f.store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n;
  await open(f.page); await fill(f.page); await f.page.locator('#owner-offer-preview').click(); assert.match(await f.page.locator('#owner-offer-preview-view').textContent(), /12.50 credit/);
  assert.doesNotMatch(await f.page.locator('#owner-offer-preview-view').textContent(), /reviewerMemberIds|owner/);
  await f.page.locator('#owner-offer-save').click(); await saved(f.page);
  const row = f.store.projectOffers.ownerList('commons', 'owner').offers[0]; assert.equal(row.reward.amountMinor, '12500'); assert.equal(row.status, 'draft');
  assert.throws(() => f.store.projectOffers.read(row.id), error => error.code === 'offer_not_found');
  f.page.on('dialog', dialog => dialog.accept()); await f.page.locator('[data-publish]').click(); await f.page.locator('#owner-offer-status').filter({ hasText: 'Published.' }).waitFor(); assert.equal(f.store.projectOffers.read(row.id).paymentStatus, 'ledger_only');
  await f.page.locator('[data-withdraw]').click(); await f.page.locator('#owner-offer-status').filter({ hasText: 'Withdrawn' }).waitFor(); assert.throws(() => f.store.projectOffers.read(row.id), error => error.code === 'offer_not_found');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n, before);
});
for (const failure of ['lost response', 'server error after commit']) test(`${failure} retries exact payload and request identity once`, { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f.page); await fill(f.page, { reward: 'USD' }); const payloads = []; let lose = true;
  await f.page.route('**/api/rooms/commons/project-offers', async route => { if (route.request().method() !== 'POST') return route.continue(); payloads.push(route.request().postData()); const response = await route.fetch(); if (lose) { lose = false; if (failure === 'lost response') await route.abort('failed'); else await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Storage unavailable' } }) }); } else await route.fulfill({ response }); });
  await f.page.locator('#owner-offer-save').click(); await f.page.locator('#owner-offer-retry').waitFor(); assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers.length, 1); assert.equal(await f.page.locator('#owner-offer-form [name=title]').inputValue(), 'Improve the welcome flow'); assert.equal(await f.page.locator('#owner-offer-save').isDisabled(), true);
  await f.page.locator('#owner-offer-retry').click(); await saved(f.page); assert.equal(payloads.length, 2); assert.equal(payloads[0], payloads[1]); assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers.length, 1);
});
test('mobile owner cash draft remains truthful and nonowner has no posting action', { timeout: 45000 }, async t => {
  const f = await setup(t, { mobile: true }); await open(f.page); await fill(f.page, { reward: 'USDC' }); await f.page.locator('#owner-offer-preview').click(); assert.match(await f.page.locator('#owner-offer-reward-note').textContent(), /not configured/); assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.locator('#owner-offer-save').click(); await saved(f.page); assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers[0].reward.amountMinor, '12345678');
  await f.page.locator('#owner-offers-close').click(); assert.equal(await f.page.locator('#owner-offers-dialog').isVisible(), false);
  const guest = await setup(t, { member: 'guest' }); assert.equal(await guest.page.locator('#owner-offers-open').isVisible(), false);
});
test('fresh server reviewer denial preserves unsaved form without publishing', { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f.page); await fill(f.page, { reward: 'unpaid' });
  const state = structuredClone(f.store.room('commons').state); state.members.owner.permissions = state.members.owner.permissions.filter(permission => permission !== 'decide'); f.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  await f.page.locator('#owner-offer-save').click(); await f.page.locator('#owner-offer-status').filter({ hasText: 'Couldn’t save' }).waitFor(); assert.equal(await f.page.locator('#owner-offer-form [name=title]').inputValue(), 'Improve the welcome flow'); assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers.length, 0);
});
test('amount conversion is exact and rejects ambiguous numeric input', () => { assert.equal(offerMinorUnits('999999999999.999999', 6), '999999999999999999'); for (const raw of ['1e3', '-1', '01', '1.0001', '0', 'NaN']) assert.throws(() => offerMinorUnits(raw, 3)); });

for (const mode of ['agent', 'human_with_agent_review']) test(`owner publishes ${mode} approval using current eligible reviewers`, { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f.page); await fill(f.page, { reward: 'unpaid' }); await f.page.locator('#owner-offer-form [name=approval]').selectOption(mode); await f.page.locator('#owner-offer-form [name=agent]').selectOption('reviewer'); await f.page.locator('#owner-offer-save').click(); await saved(f.page); await f.page.locator('[data-publish]').click(); await f.page.locator('#owner-offer-status').filter({ hasText: 'Published.' }).waitFor(); const record = f.store.projectOffers.ownerList('commons', 'owner').offers[0]; assert.equal(record.approvalPolicy.mode, mode); assert.deepEqual(record.reviewerMemberIds, mode === 'agent' ? ['reviewer'] : ['owner', 'reviewer']);
});
test('unpublishable draft is prevented locally and logout clears private owner form', { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f.page); await fill(f.page); await f.page.locator('#owner-offer-form [name=submission]').fill(''); await f.page.locator('#owner-offer-save').click(); await f.page.locator('#owner-offer-status').filter({ hasText: 'Add a public return link' }).waitFor(); assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers.length, 0);
  await f.page.locator('#owner-offers-close').click(); f.page.on('dialog', dialog => dialog.accept()); await f.page.locator('#session-menu-button').click(); await f.page.locator('#signout-button').click(); await f.page.locator('#auth-panel').waitFor({ state: 'visible' }); assert.equal(await f.page.locator('#owner-offer-form [name=title]').inputValue(), ''); assert.equal(await f.page.locator('#owner-offers-open').isVisible(), false); assert.equal(await f.page.locator('#owner-offer-preview-view').textContent(), '');
});

test('held pre-write owner list cannot erase a saved draft receipt', { timeout: 45000 }, async t => {
  const f = await setup(t); let release, observed; let first = true;
  const held = new Promise(resolve => { release = resolve; }), captured = new Promise(resolve => { observed = resolve; }); t.after(() => release());
  await f.page.route('**/api/rooms/commons/project-offers', async route => {
    if (route.request().method() !== 'GET' || !first) return route.continue();
    first = false; const response = await route.fetch(); observed(); await held; await route.fulfill({ response });
  });
  await open(f.page); await captured; await fill(f.page); await f.page.locator('#owner-offer-save').click(); await saved(f.page);
  assert.equal(await f.page.locator('[data-publish]').count(), 1); assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers.length, 1);
  const delivered = f.page.waitForEvent('requestfinished', request => request.method() === 'GET' && request.url().endsWith('/project-offers'));
  release(); await delivered; await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('[data-publish]').count(), 1, 'obsolete pre-write list must not erase the saved receipt');
  await f.page.locator('#owner-offers-refresh').click(); await f.page.locator('[data-publish]').waitFor(); assert.equal(await f.page.locator('[data-publish]').count(), 1);
});
