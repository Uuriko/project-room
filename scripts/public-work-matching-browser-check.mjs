// Actual owner enable → anonymous suggestions → outside-agent claim. No live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { signInFixtureInPlace } from './in-place-fixture-signin.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createAgentIdentity } from '../client/room-agent.mjs';
import { PublicWorkClaimsClient } from '../client/public-work-claims.mjs';
async function setup(t, width) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, assetRoot: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 320, hasTouch: width === 320 });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); assert.deepEqual(errors, []); });
  await page.goto(`${origin}/?room=commons`); await signInFixtureInPlace(page, fixture.store, fixture.keys.owner);
  return { ...fixture, page, browser, origin };
}
for (const width of [1280, 320]) test(`owner enables scoped public work and anonymous visitor finds it at ${width}px`, { timeout: 45000 }, async t => {
  const f = await setup(t, width), page = f.page;
  await page.locator('#room-more > summary').click(); await page.locator('#owner-offers-open').click();
  const form = page.locator('#owner-offer-form');
  await form.locator('[name=title]').fill('JavaScript welcome improvement'); await form.locator('[name=summary]').fill('Improve a small welcome component');
  await form.locator('[name=criteria]').fill('JavaScript keyboard accessibility'); await form.locator('[name=reward]').selectOption('unpaid'); await form.locator('[name=human]').selectOption('owner');
  await form.locator('details > summary').click(); await form.locator('[name=repository]').fill('https://github.com/Uuriko/project-room');
  await page.locator('#owner-offer-save').click(); await page.locator('[data-publish]').waitFor(); await page.locator('[data-publish]').click();
  const enable = page.locator('[data-enable-claims]'); await enable.waitFor(); const offerId = await enable.getAttribute('data-enable-claims');
  await enable.click(); const claimForm = page.locator('#owner-public-claims-form');
  assert.equal(await claimForm.locator('[name=repositoryRef]').evaluate(node => node === document.activeElement), true);
  await claimForm.locator('[name=repositoryRef]').fill('feature/welcome'); await claimForm.locator('[name=files]').fill('src/welcome.js\nsrc/shared.js');
  await page.locator('#owner-public-claims-cancel').click(); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_tasks').get().n, 0);
  await enable.click(); await claimForm.locator('[name=repositoryRef]').fill('feature/welcome'); await claimForm.locator('[name=files]').fill('src/welcome.js\nsrc/shared.js');
  let interrupted = false;
  await page.route('**/project-offers/*/claims', async route => { if (interrupted) { await route.continue(); return; } interrupted = true; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); });
  if (process.env.ROOM_MATCH_SCREENSHOT_DIR) await claimForm.screenshot({ path: `${process.env.ROOM_MATCH_SCREENSHOT_DIR}/owner-public-claims-enable-${width}.png` });
  await claimForm.locator('[type=submit]').click(); await page.locator('#owner-offer-retry').waitFor({ state: 'visible' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_tasks').get().n, 1);
  await page.locator('#owner-offer-retry').click(); await page.locator('#owner-offer-status').filter({ hasText: 'Public claims enabled' }).waitFor();
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM public_work_requests WHERE actor_id LIKE 'owner:%'").get().n, 1);
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/project-offers') && response.request().method() === 'GET'), page.locator('#owner-offers-refresh').click()]);
  assert.equal(await enable.count(), 0); assert.match(await page.locator('#owner-offers-list').textContent(), /Public claims enabled/);
  await page.locator('#owner-offers-close').click(); await page.reload(); await page.locator('#room-more > summary').click(); await page.locator('#owner-offers-open').click();
  await page.locator('#owner-offers-list').filter({ hasText: 'Public claims enabled' }).waitFor(); assert.equal(await page.locator('[data-enable-claims]').count(), 0);
  if (process.env.ROOM_MATCH_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.ROOM_MATCH_SCREENSHOT_DIR}/owner-public-claims-${width}.png`, fullPage: true });
  const visitor = await f.browser.newPage({ viewport: { width, height: 900 }, isMobile: width === 320, hasTouch: width === 320 }); visitor.setDefaultTimeout(10000);
  await visitor.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
  const requests = []; visitor.on('request', request => requests.push(request));
  await visitor.goto(`${f.origin}/offers`); await visitor.locator('#find-work-form [name=skills]').fill('JavaScript'); await visitor.locator('#find-work-form [name=interests]').fill('Accessibility');
  let failedSuggestion = false;
  await visitor.route('**/api/public-work/match', async route => { if (failedSuggestion) { await route.continue(); return; } failedSuggestion = true; await route.fetch(); await route.abort('failed'); });
  await visitor.locator('#find-work-form [type=submit]').click(); await visitor.locator('#find-work-status').filter({ hasText: 'Couldn’t find work' }).waitFor();
  assert.equal(await visitor.locator('#find-work-form [name=skills]').inputValue(), 'JavaScript');
  await visitor.locator('#find-work-form [type=submit]').click(); await visitor.locator('[data-match-offer]').waitFor();
  assert.match(await visitor.locator('#find-work-results').textContent(), /Matches preference: javascript/);
  assert.equal(f.store.workClaims.list(f.store.publicWorkClaims.read(offerId).namespaceId)[0].owner, null, 'suggestions do not assign work');
  assert.ok(requests.filter(request => request.url().endsWith('/api/public-work/match')).every(request => !request.headers().authorization && !request.headers().cookie));
  await visitor.locator('[data-copy-claim]').click(); const packet = visitor.locator('#find-work-results textarea'); await packet.waitFor({ state: 'visible' });
  assert.match(await packet.inputValue(), new RegExp(`/tasks/${offerId}/claim`)); assert.match(await packet.inputValue(), /"expectedTermsVersion": 1/);
  assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.ROOM_MATCH_SCREENSHOT_DIR) await visitor.screenshot({ path: `${process.env.ROOM_MATCH_SCREENSHOT_DIR}/public-work-matching-${width}.png`, fullPage: true });
  await visitor.locator('[data-match-offer]').click(); await visitor.locator('#copy-offer:not(:disabled)').waitFor(); await visitor.goBack();
  assert.equal(new URL(visitor.url()).searchParams.has('offer'), false);
  await visitor.locator('#find-work-form [name=reward]').selectOption('cash'); await visitor.locator('#find-work-form [type=submit]').click(); await visitor.locator('#find-work-status').filter({ hasText: 'No claimable cash matches' }).waitFor(); assert.equal(await visitor.locator('[data-copy-claim]').count(), 0);
  const identity = await createAgentIdentity(f.origin, 'Synthetic explicit contributor');
  const client = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: identity.secret });
  const claimed = await client.claim(offerId, { requestId: 'human-handoff-claim', expectedTermsVersion: 1 }); assert.equal(claimed.task.claim.identityId, identity.identityId);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE identity_id=?').get(identity.identityId).n, 0);
  await visitor.locator('#find-work-form [name=reward]').selectOption('volunteer'); await visitor.locator('#find-work-form [type=submit]').click(); await visitor.locator('#find-work-status').filter({ hasText: 'No matching public tasks' }).waitFor();
  await visitor.goto(`${f.origin}/offers?offer=${offerId}`); await visitor.locator('#contribution-status').filter({ hasText: 'Agent working' }).waitFor();
  const artifactText = '<script>throw new Error("untrusted artifact")</script>\n雪 🧪';
  const submitted = await client.finish(offerId, { requestId: 'human-handoff-finish', expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText, checksReported: ['Contributor-reported check'] });
  if (width === 320) await visitor.reload(); else await visitor.locator('#refresh-offers').click();
  await visitor.locator('#contribution-artifact').waitFor();
  assert.match(await visitor.locator('#contribution-status').textContent(), /Submitted/); assert.match(await visitor.locator('#contribution-status').textContent(), /review pending/); assert.match(await visitor.locator('#contribution-status').textContent(), /Hash-only/);
  assert.match(await visitor.locator('#contribution-artifact').textContent(), new RegExp(`${Buffer.byteLength(artifactText, 'utf8')} bytes`));
  assert.equal(await visitor.locator('#contribution-status script').count(), 0);
  if (process.env.ROOM_MATCH_SCREENSHOT_DIR) await visitor.locator('#contribution-status').screenshot({ path: `${process.env.ROOM_MATCH_SCREENSHOT_DIR}/public-contribution-result-${width}.png` });
  const artifactPath = await visitor.locator('#contribution-artifact').getAttribute('href'), receiptPath = await visitor.locator('#contribution-receipt').getAttribute('href');
  assert.equal(artifactPath, `/api/public-work/receipts/${submitted.receipt.receiptId}/artifact`);
  assert.equal((await (await visitor.request.get(f.origin + receiptPath)).json()).receiptId, submitted.receipt.receiptId);
  const [download] = await Promise.all([visitor.waitForEvent('download'), visitor.locator('#contribution-artifact').click()]);
  assert.deepEqual(readFileSync(await download.path()), Buffer.from(artifactText, 'utf8'));
  f.store.projectOffers.transition('commons', 'owner', offerId, 'withdraw', { requestId: 'after-submission-withdraw', expectedRevision: 2 });
  if (width === 320) await visitor.reload(); else await visitor.locator('#refresh-offers').click();
  await visitor.locator('#detail-title').filter({ hasText: 'Offer unavailable' }).waitFor();
  assert.equal((await visitor.request.get(f.origin + artifactPath)).status(), 200, 'immutable public submission survives withdrawal');

});


test('an empty bounded recommendation page offers a working next scan', { timeout: 45000 }, async t => {
  const f = await setup(t, 320), identity = f.store.identities.create('Synthetic prior worker');
  f.store.initialize(initialRoom('overflow'));
  for (let n = 0; n < 101; n++) {
    const id = `page-${String(n).padStart(3, '0')}`, room = n === 100 ? 'overflow' : 'commons';
    f.store.projectOffers.create(room, 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'], terms: { kind: 'task', title: id, summary: 'A useful contribution', acceptanceCriteria: ['Read the declared paths'], repositoryUrl: 'https://github.com/Uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    f.store.projectOffers.transition(room, 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    f.store.publicWorkClaims.enable(room, 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`files/${id}`] });
    if (n < 100) f.store.publicWorkClaims.act(id, identity.secret, 'claim', { requestId: `hold-${id}`, expectedTermsVersion: 1 });
  }
  await f.page.goto(`${f.origin}/offers`); await f.page.locator('#find-work-form [type=submit]').click();
  await f.page.locator('#more-matches').waitFor({ state: 'visible' }); assert.equal(await f.page.locator('[data-match-offer]').count(), 0);
  await f.page.locator('#more-matches').click(); await f.page.locator('[data-match-offer="page-100"]').waitFor();
  assert.equal(await f.page.locator('#more-matches').isVisible(), false);
  assert.equal(f.store.publicWorkClaims.read('page-100').claim.state, 'unclaimed');
  let observed, release, delivered;
  const oldObserved = new Promise(resolve => { observed = resolve; }), held = new Promise(resolve => { release = resolve; }), oldDelivered = new Promise(resolve => { delivered = resolve; });
  await f.page.route('**/api/public-work/tasks/page-100', async route => {
    const response = await route.fetch(); observed(); await held;
    try { await route.fulfill({ response }); } finally { delivered(); }
  });
  await f.page.locator('[data-match-offer="page-100"]').click(); await oldObserved;
  await f.page.locator('[data-close]').click(); await f.page.locator('[data-offer="page-000"]').click();
  await f.page.locator('#contribution-status').filter({ hasText: 'Agent working' }).waitFor();
  release(); await oldDelivered; await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await f.page.locator('#contribution-status').textContent(), /Agent working/);
  assert.equal(await f.page.locator('#contribution-artifact').count(), 0);

});

test('edge-host copied instructions use the real prefixed API without inventing an offers mount', { timeout: 45000 }, async t => {
  const f = await setup(t, 1280), id = 'edge:task';
  f.store.projectOffers.create('commons', 'owner', { requestId: 'edge-create', offerId: id, reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'Edge contribution', summary: 'A useful change', acceptanceCriteria: ['Keyboard access works'], repositoryUrl: 'https://github.com/Uuriko/project-room', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  f.store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: 'edge-publish', expectedRevision: 1 });
  f.store.publicWorkClaims.enable('commons', 'owner', id, { requestId: 'edge-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/edge.js'] });
  const edge = await f.browser.newPage(), paths = [], edgeErrors = []; edge.setDefaultTimeout(10000);
  edge.on('pageerror', error => edgeErrors.push(error.message));
  // This forwards the browser document to the actual local service; it is not a
  // proof that /offers or /room/offers is deployed on the external website.
  // Rewrite Origin to the disposable service too; retain its real origin checks.
  await edge.route('https://www.getdasha.com/**', async route => {
    const url = new URL(route.request().url()); paths.push(url.pathname);
    const response = await route.fetch({ url: f.origin + url.pathname + url.search, headers: { ...route.request().headers(), Origin: f.origin } });
    assert.equal(response.status(), 200, `forwarded actual fixture path ${url.pathname}`);
    await route.fulfill({ response });
  });
  await edge.goto('https://www.getdasha.com/offers');
  await edge.locator('#find-work-form').waitFor(); assert.deepEqual(edgeErrors, []);
  await edge.locator('#find-work-form [type=submit]').click(); await edge.locator('[data-match-offer]').waitFor();
  await edge.locator('#find-work-results summary').click(); const prompt = await edge.locator('#find-work-results textarea').inputValue();
  assert.match(prompt, /https:\/\/www\.getdasha\.com\/room\/api\/public-work\/tasks\/edge%3Atask\/claim/);
  assert.match(prompt, /POST https:\/\/www\.getdasha\.com\/room\/api\/agent-identities/);
  assert.match(prompt, /Origin: https:\/\/www\.getdasha\.com/); assert.match(prompt, /User-Agent: project-room-agent/); assert.match(prompt, /Keyboard access works/);
  assert.ok(paths.includes('/room/api/public-work/match'));
  assert.equal(paths.includes('/api/public-work/match'), false);
  assert.equal(f.store.publicWorkClaims.read(id).claim.state, 'unclaimed');
  assert.equal((await fetch(f.origin + '/room/offers')).status, 404, 'the Node app has no claimed mounted offers route');
});
