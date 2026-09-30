// Public offer journeys against the real Node HTTP/store boundary; no identities
// are enrolled and no external host, mail, funding or cashout is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

function publish(store, id, reward, extra = {}) {
  store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'], terms: {
    kind: 'task', title: `${id} · useful work`, summary: 'A focused contribution with clear scope.', acceptanceCriteria: ['A working result', 'A reproducible check'], exclusions: ['No production deploy'], repositoryUrl: 'https://github.com/Uuriko/project-room', reward, approvalPolicy: { mode: 'human' }, ...extra
  } });
  store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
}
async function setup(t, { seeded = true, viewportWidth = 1280 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'offers-browser-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  if (seeded) {
    publish(store, 'a-unpaid', { kind: 'unpaid' });
    publish(store, 'b-trade', { kind: 'work_trade', unit: 'credit', amountMinor: '12500', basis: 'pool', terms: 'Exchange useful contributions.' });
    publish(store, 'c-cash', { kind: 'cash', unit: 'USD', amountMinor: '25000', terms: 'Payment setup must be agreed separately.' }, { kind: 'project', title: 'Make the welcome flow easier', summary: 'Help new people find their first useful conversation.', repositoryUrl: 'https://github.com/Uuriko/project-room', submissionUrl: 'https://github.com/Uuriko/project-room/issues', deadline: '2026-10-31T18:00:00Z' });
    publish(store, 'd-usdc', { kind: 'cash', unit: 'USDC', amountMinor: '123456789' });
  }
  const server = createRoomServer({ store, assetRoot: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: 900 }, isMobile: viewportWidth === 320, hasTouch: viewportWidth === 320 }); const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { store, page, context, origin };
}
async function open(f, id = 'c-cash') {
  await f.page.goto(`${f.origin}/offers?offer=${id}`); await f.page.locator('#copy-offer:not(:disabled)').waitFor();
}

test('public offers show exact trade/cash terms, keyboard detail and actual download without mutations', { timeout: 45000 }, async t => {
  const f = await setup(t), writes = [];
  f.page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  const ledgerBefore = f.store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n;
  await f.page.goto(`${f.origin}/offers`); await f.page.locator('[data-offer="c-cash"]').waitFor();
  const chips = await f.page.locator('.reward-chip').allTextContents(); assert.deepEqual(chips, ['Unpaid', 'Proposed 12.5 credits pool', 'Proposed $250', 'Proposed 123.456789 USDC']);
  await f.page.locator('[data-offer="c-cash"]').focus(); await f.page.keyboard.press('Enter'); await f.page.locator('#copy-offer:not(:disabled)').waitFor();
  assert.equal(await f.page.locator('#detail-title').evaluate(node => node === document.activeElement), true);
  assert.match(await f.page.locator('.offer-detail').textContent(), /Human review/);
  assert.equal(await f.page.getByRole('link', { name: 'Contribution instructions' }).getAttribute('href'), 'https://github.com/Uuriko/project-room/issues');
  assert.match(await f.page.locator('.offer-detail').textContent(), /Funding and payment are not configured\. Cashout is unavailable/);
  await f.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await f.page.locator('#copy-offer').click(); await f.page.locator('#copy-status').filter({ hasText: 'Copied.' }).waitFor();
  assert.equal(await f.page.evaluate(() => navigator.clipboard.readText()), await f.page.locator('#offer-prompt').inputValue());
  const downloadEvent = f.page.waitForEvent('download'); await f.page.locator('#download-offer').click(); const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'SKILL.md');
  const stream = await download.createReadStream(); let text = ''; for await (const chunk of stream) text += chunk;
  assert.ok(text.startsWith('---\n'), 'download is an Agent Skills file, not a renamed prompt');
  assert.match(text, /^name: /m); assert.match(text, /^description: /m);
  assert.ok(text.includes('Make the welcome flow easier')); assert.ok(text.includes('25000'));
  const brief = await f.page.locator('#offer-prompt').inputValue(); assert.equal(text, brief);
  assert.deepEqual(writes, []); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n, ledgerBefore);
});

test('empty and bounded pagination use actual persisted offers', { timeout: 45000 }, async t => {
  const f = await setup(t, { seeded: false }); await f.page.goto(`${f.origin}/offers`);
  await f.page.locator('#list-status').filter({ hasText: 'No open offers yet' }).waitFor(); assert.equal(await f.page.locator('.offer-card').count(), 0);
  for (let i = 0; i < 21; i++) publish(f.store, `task-${String(i).padStart(2, '0')}`, { kind: 'unpaid' });
  await f.page.locator('#refresh-offers').click(); await f.page.locator('.offer-card').nth(19).waitFor(); assert.equal(await f.page.locator('.offer-card').count(), 20);
  await f.page.locator('#more-offers').click(); await f.page.locator('.offer-card').nth(20).waitFor(); assert.equal(await f.page.locator('#more-offers').isVisible(), false);
});

test('held list remains loading; failed transport exposes a working public retry', { timeout: 45000 }, async t => {
  const f = await setup(t); let release; let observed;
  const held = new Promise(resolve => { observed = resolve; }); const unblock = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await f.page.route('**/api/project-offers?*', async route => { observed(); await unblock; await route.abort('failed'); });
  await f.page.goto(`${f.origin}/offers`); await held;
  assert.match(await f.page.locator('#list-status').textContent(), /Loading/); assert.equal(await f.page.locator('.offer-card').count(), 0);
  release(); await f.page.locator('#list-status').filter({ hasText: 'Couldn’t load offers' }).waitFor();
  await f.page.unroute('**/api/project-offers?*'); await f.page.locator('#refresh-offers').click(); await f.page.locator('[data-offer="c-cash"]').waitFor();
});

test('failed detail and brief reads retain precise retry; late selection cannot replace current offer', { timeout: 45000 }, async t => {
  const f = await setup(t); await f.page.route('**/api/project-offers/c-cash', route => route.abort('failed'));
  await f.page.goto(`${f.origin}/offers?offer=c-cash`); await f.page.locator('[data-retry="c-cash"]').waitFor();
  assert.equal(new URL(f.page.url()).searchParams.get('offer'), 'c-cash'); assert.equal(await f.page.locator('#copy-offer').count(), 0);
  await f.page.unroute('**/api/project-offers/c-cash'); await f.page.route('**/api/project-offers/c-cash/brief.md', route => route.abort('failed'));
  await f.page.locator('[data-retry]').click(); await f.page.locator('#retry-brief').waitFor(); assert.equal(await f.page.locator('#copy-offer').isDisabled(), true);
  await f.page.unroute('**/api/project-offers/c-cash/brief.md'); await f.page.locator('#retry-brief').click(); await f.page.locator('#copy-offer:not(:disabled)').waitFor();
  let observed, release; const held = new Promise(resolve => { observed = resolve; }); const unblock = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await f.page.route('**/api/project-offers/b-trade', async route => { const response = await route.fetch(); observed(); await unblock; await route.fulfill({ response }).catch(() => {}); });
  await f.page.locator('[data-offer="b-trade"]').click(); await held; await f.page.locator('[data-offer="d-usdc"]').click(); await f.page.locator('#copy-offer:not(:disabled)').waitFor();
  release(); await f.page.waitForTimeout(50); assert.equal(await f.page.locator('#detail-title').textContent(), 'd-usdc · useful work'); assert.match(await f.page.locator('#offer-prompt').inputValue(), /d-usdc/);
});

test('copy fallback is selected and readable; withdrawn offer cannot copy a cached prompt', { timeout: 45000 }, async t => {
  const f = await setup(t); await f.page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined })); await open(f);
  await f.page.locator('#copy-offer').click(); await f.page.locator('#copy-status').filter({ hasText: 'Copy the selected prompt' }).waitFor();
  const selection = await f.page.locator('#offer-prompt').evaluate(node => ({ focused: node === document.activeElement, selected: node.selectionEnd - node.selectionStart, length: node.value.length }));
  assert.equal(selection.focused, true); assert.equal(selection.selected, selection.length); assert.ok(selection.length > 0);
  f.store.projectOffers.transition('commons', 'owner', 'c-cash', 'withdraw', { requestId: 'withdraw-visible', expectedRevision: 2 });
  await f.page.locator('#copy-offer').click(); await f.page.getByRole('heading', { name: 'Offer unavailable' }).waitFor();
  assert.equal(await f.page.locator('#offer-prompt').count(), 0); assert.equal(await f.page.locator('#copy-offer').count(), 0); assert.equal(await f.page.locator('#download-offer').count(), 0);
  assert.equal(await f.page.locator('[data-offer="c-cash"]').count(), 0);
});

for (const width of [1280, 320]) test(`offers fit ${width}px and preserve keyboard/mobile return`, { timeout: 45000 }, async t => {
  const f = await setup(t, { viewportWidth: width }); await open(f);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const button = await f.page.locator('#copy-offer').boundingBox(); assert.ok(button.height >= 44);
  const screenshot = process.env.ROOM_OFFERS_SCREENSHOT_DIR;
  if (screenshot) await f.page.screenshot({ path: join(screenshot, `project-offers-${width}.png`), fullPage: true });
  if (width === 320) { await f.page.locator('[data-close]').tap(); assert.equal(new URL(f.page.url()).searchParams.has('offer'), false); assert.equal(await f.page.locator('[data-offer="c-cash"]').evaluate(node => node === document.activeElement), true); await f.page.locator('[data-offer="c-cash"]').tap(); await f.page.locator('#copy-offer:not(:disabled)').waitFor(); await f.page.goBack(); assert.equal(await f.page.locator('[data-offer="c-cash"]').evaluate(node => node === document.activeElement), true); await f.page.goForward(); await f.page.locator('#copy-offer:not(:disabled)').waitFor(); }
  else { await f.page.locator('[data-offer="b-trade"]').click(); await f.page.locator('#copy-offer:not(:disabled)').waitFor(); assert.match(await f.page.locator('.offer-detail').textContent(), /Work trade.*ledger only/s); await f.page.goBack(); await f.page.getByRole('heading', { name: 'Make the welcome flow easier' }).waitFor(); f.store.projectOffers.transition('commons', 'owner', 'c-cash', 'withdraw', { requestId: 'withdraw-refresh', expectedRevision: 2 }); await f.page.locator('#refresh-offers').click(); await f.page.getByRole('heading', { name: 'Offer unavailable' }).waitFor(); assert.equal(await f.page.locator('#copy-offer').count(), 0); }
});

test('maximum public text remains literal and fits a narrow viewport without truncating the brief', { timeout: 45000 }, async t => {
  const f = await setup(t, { seeded: false });
  const prefix = '<img src=x onerror=alert(1)> ';
  const summary = prefix + 'S'.repeat(4000 - prefix.length);
  publish(f.store, 'long-scope', { kind: 'cash', unit: 'USD', amountMinor: '999999999999999999' }, { title: 'T'.repeat(200), summary, acceptanceCriteria: ['B'.repeat(1000)] });
  await f.page.setViewportSize({ width: 320, height: 900 }); await open(f, 'long-scope');
  assert.equal(await f.page.locator('.summary').textContent(), summary);
  assert.equal(await f.page.locator('#offer-detail img').count(), 0, 'public text cannot create markup');
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'legal unbroken title/summary/reward fit mobile');
  assert.ok((await f.page.locator('#offer-prompt').inputValue()).includes(summary), 'copied brief retains full public terms');
  for (let i = 0; i < 19; i++) publish(f.store, `maximum-${i}`, { kind: 'cash', unit: 'USD', amountMinor: '999999999999999999', terms: 'R'.repeat(2000) }, {
    title: 'T'.repeat(200), summary: 'S'.repeat(4000), acceptanceCriteria: Array.from({ length: 20 }, () => 'B'.repeat(1000)), exclusions: Array.from({ length: 20 }, () => 'E'.repeat(1000))
  });
  await f.page.goto(`${f.origin}/offers`);
  await f.page.waitForFunction(() => !document.querySelector('#refresh-offers').disabled);
  assert.equal(await f.page.locator('.offer-card').count(), 20, 'a full page of legal maximum terms is readable');
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

});

test('published colon IDs survive list, encoded detail routing, clipboard and return focus', { timeout: 45000 }, async t => {
  const f = await setup(t, { seeded: false, viewportWidth: 320 });
  publish(f.store, 'team:task', { kind: 'unpaid' }, { title: 'Colon identifier contribution' });
  await f.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await f.page.goto(`${f.origin}/offers`);
  await f.page.locator('[data-offer="team:task"]').waitFor();
  assert.equal(await f.page.locator('.offer-card').count(), 1);
  await f.page.locator('[data-offer="team:task"]').click();
  await f.page.locator('#copy-offer:not(:disabled)').waitFor();
  assert.equal(new URL(f.page.url()).searchParams.get('offer'), 'team:task');
  assert.equal(await f.page.locator('#detail-title').textContent(), 'Colon identifier contribution');
  assert.equal(await f.page.locator('#download-offer').getAttribute('href'), '/api/project-offers/team%3Atask/brief.md');
  await f.page.locator('#copy-offer').click();
  await f.page.locator('#copy-status').filter({ hasText: 'Copied.' }).waitFor();
  const copied = await f.page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.startsWith('---\n'));
  assert.ok(copied.includes('Colon identifier contribution'));
  await f.page.reload(); await f.page.locator('#copy-offer:not(:disabled)').waitFor();
  assert.equal(await f.page.locator('#detail-title').textContent(), 'Colon identifier contribution');
  await f.page.getByRole('button', { name: /All offers/ }).click();
  assert.equal(await f.page.locator('[data-offer="team:task"]').evaluate(node => node === document.activeElement), true);
});
