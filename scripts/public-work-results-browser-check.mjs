// Real HTTP submission/review and private owner UI; no live identities or mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { signInFixtureInPlace } from './in-place-fixture-signin.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createAgentIdentity } from '../client/room-agent.mjs';
import { PublicWorkClaimsClient } from '../client/public-work-claims.mjs';
async function setup(t, { width = 1280, mixed = false, withdrawn = false } = {}) {
  const fixture = createAcceptanceFixture(), { store } = fixture;
  const mode = mixed ? 'human_with_agent_review' : 'human', id = 'result-task';
  store.projectOffers.create('commons', 'owner', { requestId: 'create-result', offerId: id, reviewerMemberIds: mixed ? ['owner', 'reviewer'] : ['owner'], terms: { kind: 'task', title: 'Review the exact contribution', summary: 'A small public contribution', acceptanceCriteria: ['Readable result <script>window.untrustedCriterion=true</script>'], exclusions: ['No unrelated edits'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
  store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: 'publish-result', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', id, { requestId: 'enable-result', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  const server = createRoomServer({ store, assetRoot: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width === 320, hasTouch: width === 320 }); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); assert.deepEqual(errors, []); });
  const identity = await createAgentIdentity(origin, 'Disposable contributor'), client = new PublicWorkClaimsClient({ origin, identitySecret: identity.secret });
  const claimed = await client.claim(id, { requestId: 'claim-result', expectedTermsVersion: 1 });
  const artifactText = '<script>window.untrustedArtifact=true</script> 🐈';
  const { receipt } = await client.finish(id, { requestId: 'finish-result', expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText, checksReported: ['Contributor reports readable output'] });
  if (withdrawn) store.projectOffers.transition('commons', 'owner', id, 'withdraw', { requestId: 'withdraw-result', expectedRevision: 2 });
  await page.goto(`${origin}/?room=commons`); await signInFixtureInPlace(page, store, fixture.keys.owner);
  return { ...fixture, page, origin, receipt, identity, artifactText };
}
async function open(f) { await f.page.locator('#room-more > summary').click(); await f.page.locator('#owner-offers-open').click(); await f.page.locator('#owner-results-open').click(); await f.page.locator('[data-result-receipt]').waitFor(); }
const row = f => f.page.locator(`[data-result-receipt="${f.receipt.receiptId}"]`);
const recorded = f => f.page.locator('#owner-offer-status').filter({ hasText: 'Review recorded' }).waitFor();
async function decide(f, decision, reason) { await row(f).locator('[data-review-feedback]').fill(reason); await row(f).locator(`[data-review-decision="${decision}"]`).click(); await recorded(f); }
for (const width of [1280, 320]) test(`withdrawn contribution remains inspectable and explicit feedback stays safe at ${width}px`, { timeout: 45000 }, async t => {
  const f = await setup(t, { width, withdrawn: true }); await open(f);
  assert.match(await row(f).textContent(), /Offer withdrawn/); assert.equal(await f.page.locator('#owner-offer-form').isVisible(), true);
  const details = row(f).locator('[data-result-task-details]'); assert.equal(await details.evaluate(node => node.open), false); await details.locator('summary').click();
  assert.match(await details.textContent(), /Readable result <script>window.untrustedCriterion=true<\/script>/); assert.match(await details.textContent(), /No unrelated edits/); assert.match(await details.textContent(), /Branch or commit: main/); assert.match(await details.textContent(), /result.txt/);
  assert.equal(await details.getByRole('link', { name: 'Repository' }).getAttribute('href'), 'https://github.com/example/project'); assert.equal(await details.locator('script').count(), 0); assert.equal(await f.page.evaluate(() => Boolean(window.untrustedCriterion)), false);
  assert.equal(await details.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'original criteria and file scope must wrap within the review panel');
  if (process.env.ROOM_RESULTS_SCREENSHOT_DIR) { await details.scrollIntoViewIfNeeded(); await f.page.screenshot({ path: `${process.env.ROOM_RESULTS_SCREENSHOT_DIR}/owner-results-task-details-${width}.png`, fullPage: true }); }
  const download = f.page.waitForEvent('download'); await row(f).getByRole('link', { name: /Download result/ }).click(); const file = await download;
  assert.equal(readFileSync(await file.path(), 'utf8'), f.artifactText); assert.equal(await f.page.evaluate(() => Boolean(window.untrustedArtifact)), false);
  const feedback = 'Please revise\n<script>window.untrustedFeedback=true</script>';
  await decide(f, 'revision_requested', feedback); assert.match(await row(f).textContent(), /Revision requested/);
  assert.equal(await row(f).locator('script').count(), 0); assert.equal(await row(f).locator('[data-review-decision="accepted"]').isVisible(), true);
  await decide(f, 'accepted', 'Reviewed the same immutable artifact.'); assert.equal(await row(f).locator('[data-review-decision="accepted"]').isVisible(), false);
  const response = await fetch(`${f.origin}/api/public-work/receipts/${f.receipt.receiptId}/review`, { headers: { Authorization: `Bearer ${f.identity.secret}` } });
  assert.equal(response.status, 200); const status = await response.json(); assert.match(JSON.stringify(status), /Reviewed the same immutable artifact/); assert.doesNotMatch(JSON.stringify(status), /actorId|roomId|reviewerMemberIds/);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.ROOM_RESULTS_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.ROOM_RESULTS_SCREENSHOT_DIR}/owner-results-${width}.png`, fullPage: true });
});
test('mixed approval only exposes acceptance after actual designated agent review over HTTP', { timeout: 45000 }, async t => {
  const f = await setup(t, { mixed: true }); await open(f); assert.equal(await row(f).locator('[data-review-decision="accepted"]').isVisible(), false); assert.equal(await f.page.getByRole('button', { name: /Verify|PASS/ }).count(), 0);
  const response = await fetch(`${f.origin}/api/rooms/commons/public-work/receipts/${f.receipt.receiptId}/verify`, { method: 'POST', headers: { Origin: f.origin, Authorization: `Bearer ${f.keys.reviewer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'reviewer-pass', expectedReviewRevision: 0, taskId: f.receipt.taskId, expectedTermsVersion: f.receipt.termsVersion, generation: f.receipt.generation, artifactSha256: f.receipt.artifact.sha256, verdict: 'PASS', reason: 'Independent artifact check' }) });
  assert.equal(response.status, 200, await response.text()); await f.page.locator('#owner-results-refresh').click(); await row(f).locator('[data-review-decision="accepted"]').waitFor({ state: 'visible' }); assert.match(await row(f).textContent(), /Reviewer check: PASS/);
  await decide(f, 'accepted', 'Accepted after the independent check.');
});
test('held old results and lost committed decision preserve exact retry and accepted receipt', { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f); let release, observed, hold = true, lose = true; const payloads = [];
  const held = new Promise(resolve => { release = resolve; }), captured = new Promise(resolve => { observed = resolve; }); t.after(() => release());
  await f.page.route('**/public-work/receipts/*/decide', async route => { payloads.push(route.request().postData()); const response = await route.fetch(); assert.equal(response.status(), 200); if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  await row(f).locator('[data-review-feedback]').fill('Exact feedback retained on unknown outcome.'); await row(f).locator('[data-review-decision="revision_requested"]').click(); await f.page.locator('#owner-offer-retry').waitFor();
  await f.page.route('**/public-work/results?*', async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); observed(); await held; await route.fulfill({ response }); });
  await f.page.locator('#owner-results-refresh').click(); await captured;
  assert.equal(await row(f).locator('[data-review-feedback]').inputValue(), 'Exact feedback retained on unknown outcome.'); await f.page.locator('#owner-offer-retry').click(); await recorded(f); assert.equal(payloads.length, 2); assert.equal(payloads[0], payloads[1]);
  await decide(f, 'accepted', 'Accepted the immutable result after reconsideration.');
  const delivered = f.page.waitForEvent('requestfinished', request => request.url().includes('/public-work/results?')); release(); await delivered; await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await row(f).textContent(), /Accepted/); assert.equal(await row(f).locator('[data-review-decision="accepted"]').isVisible(), false);
});
test('logout clears private result notes and a held results response cannot restore them', { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f); await row(f).locator('[data-review-feedback]').fill('Private draft feedback'); let release, observed;
  const held = new Promise(resolve => { release = resolve; }), captured = new Promise(resolve => { observed = resolve; }); t.after(() => release());
  await f.page.route('**/public-work/results?*', async route => { const response = await route.fetch(); observed(); await held; await route.fulfill({ response }); });
  await f.page.locator('#owner-results-refresh').click(); await captured; await f.page.locator('#owner-offers-close').click(); f.page.on('dialog', dialog => dialog.accept()); await f.page.locator('#session-menu-button').click(); await f.page.locator('#signout-button').click(); await f.page.locator('#auth-panel').waitFor({ state: 'visible' });
  const delivered = f.page.waitForEvent('requestfinished', request => request.url().includes('/public-work/results?')); release(); await delivered; await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('#owner-results-list').textContent(), ''); assert.equal(await f.page.locator('#owner-offers-open').isVisible(), false);
});
test('fresh reviewer denial removes stale choices and preserves contributor feedback', { timeout: 45000 }, async t => {
  const f = await setup(t); await open(f); await row(f).locator('[data-review-feedback]').fill('Review note survives a permission change.');
  const state = structuredClone(f.store.room('commons').state); state.members.owner.permissions = state.members.owner.permissions.filter(permission => permission !== 'decide'); f.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  await row(f).locator('[data-review-decision="accepted"]').click(); await f.page.locator('#owner-offer-status').filter({ hasText: 'Couldn’t record' }).waitFor();
  assert.equal(await row(f).locator('[data-review-decision="accepted"]').isVisible(), false); assert.equal(await row(f).locator('[data-review-feedback]').inputValue(), 'Review note survives a permission change.');
  assert.equal(f.store.publicWorkReviews.results('commons', 'owner').results[0].review.state, 'pending');
});
test('results read one bounded page on demand and Show more reads the next page', { timeout: 45000 }, async t => {
  const f = await setup(t), client = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: f.identity.secret });
  for (let i = 0; i < 20; i++) {
    const id = `paged-${i}`;
    f.store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'], terms: { kind: 'task', title: `Result ${i}`, summary: 'Bounded results page', acceptanceCriteria: ['Readable'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    f.store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    f.store.publicWorkClaims.enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`results/${i}.txt`] });
    const claimed = await client.claim(id, { requestId: `claim-${id}`, expectedTermsVersion: 1 }); await client.finish(id, { requestId: `finish-${id}`, expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText: `Result ${i}`, checksReported: [] });
  }
  const reads = []; f.page.on('request', request => { if (request.url().includes('/public-work/results?')) reads.push(new URL(request.url())); });
  await f.page.locator('#room-more > summary').click(); await f.page.locator('#owner-offers-open').click(); assert.equal(reads.length, 0);
  await f.page.locator('#owner-results-open').click(); await f.page.locator('#owner-results-more').waitFor({ state: 'visible' }); assert.equal(await f.page.locator('[data-result-receipt]').count(), 20); assert.equal(reads.length, 1); assert.equal(reads[0].searchParams.get('limit'), '20');
  await f.page.locator('#owner-results-more').click(); await f.page.locator('#owner-results-more').waitFor({ state: 'hidden' }); assert.equal(await f.page.locator('[data-result-receipt]').count(), 21); assert.equal(reads.length, 2); assert.ok(reads[1].searchParams.get('after'));
});
async function prepareFollowUp(f) {
  await open(f); assert.equal(await row(f).locator('[data-open-follow-up]').count(), 0);
  await decide(f, 'revision_requested', 'Private contributor feedback must not become public terms.');
  await row(f).locator('[data-open-follow-up]').click();
  const form = f.page.locator('#owner-follow-up-form'); await form.waitFor({ state: 'visible' });
  assert.equal(await form.locator('[name=title]').evaluate(node => node === document.activeElement), true);
  assert.equal(await form.locator('[name=summary]').inputValue(), 'A small public contribution');
  assert.doesNotMatch(await form.locator('[name=summary]').inputValue(), /Private contributor/);
  await form.locator('[name=title]').fill('Explicit follow-up <script>window.badChild=true</script>');
  await form.locator('[name=summary]').fill('Publicly requested improvement');
  await form.locator('[name=criteria]').fill('New readable result\nKeep the original unchanged');
  await form.locator('[name=repositoryRef]').fill('follow-up-branch');
  await form.locator('[name=files]').fill('follow-up.txt');
  return form;
}
const followUpRecorded = f => f.page.locator('#owner-offer-status').filter({ hasText: 'Follow-up published' }).waitFor();
for (const width of [1280, 320]) test(`explicit follow-up is unassigned, preserves parent bytes, and reports withdrawn child at ${width}px`, { timeout: 45000 }, async t => {
  const f = await setup(t, { width }), form = await prepareFollowUp(f), posts = [];
  f.page.on('request', request => { if (request.url().endsWith('/follow-up')) posts.push(request.postDataJSON()); });
  await form.getByRole('button', { name: 'Publish follow-up' }).click();
  assert.equal(posts.length, 0); assert.equal(f.store.publicWorkSuccessors.link(f.receipt.receiptId), null);
  if (process.env.ROOM_RESULTS_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.ROOM_RESULTS_SCREENSHOT_DIR}/owner-follow-up-form-${width}.png`, fullPage: true });
  await form.locator('[name=publicConfirm]').check(); await form.getByRole('button', { name: 'Publish follow-up' }).click(); await followUpRecorded(f);
  assert.equal(posts.length, 1); const childId = posts[0].successorTaskId;
  const child = await (await fetch(`${f.origin}/api/public-work/tasks/${childId}`)).json();
  assert.equal(child.claim.state, 'unclaimed'); assert.equal(child.claim.identityId, null); assert.deepEqual(child.files, ['follow-up.txt']); assert.equal(child.repositoryRef, 'follow-up-branch');
  assert.deepEqual(child.acceptanceCriteria, ['New readable result', 'Keep the original unchanged']);
  const parentBytes = await fetch(`${f.origin}/api/public-work/receipts/${f.receipt.receiptId}/artifact`); assert.equal(await parentBytes.text(), f.artifactText);
  assert.equal(f.store.publicWorkClaims.read(f.receipt.taskId).claim.state, 'submitted');
  const feedback = await (await fetch(`${f.origin}/api/public-work/receipts/${f.receipt.receiptId}/review`, { headers: { Authorization: `Bearer ${f.identity.secret}` } })).json();
  assert.deepEqual(feedback.followUp, { taskId: childId, termsVersion: 1, available: true });
  const outside = await createAgentIdentity(f.origin, 'Different disposable successor contributor'), client = new PublicWorkClaimsClient({ origin: f.origin, identitySecret: outside.secret });
  const claimed = await client.claim(childId, { requestId: 'child-claim', expectedTermsVersion: 1 });
  const submitted = await client.finish(childId, { requestId: 'child-finish', expectedTermsVersion: 1, generation: claimed.task.claim.generation, artifactText: 'New independent artifact', checksReported: [] });
  assert.notEqual(submitted.receipt.receiptId, f.receipt.receiptId);
  await row(f).getByRole('link', { name: 'View follow-up' }).waitFor();
  assert.equal(await row(f).getByRole('link', { name: 'View follow-up' }).getAttribute('href'), `/offers?offer=${childId}`);
  assert.equal(await f.page.evaluate(() => Boolean(window.badChild)), false);
  f.store.projectOffers.transition('commons', 'owner', childId, 'withdraw', { requestId: 'withdraw-child', expectedRevision: 2 });
  await f.page.locator('#owner-results-refresh').click(); await row(f).getByText('Follow-up unavailable.', { exact: true }).waitFor();
  assert.equal(await row(f).locator('[data-open-follow-up]').count(), 0); assert.equal(await row(f).getByRole('link', { name: 'View follow-up' }).count(), 0);
  assert.equal(await (await fetch(`${f.origin}/api/public-work/receipts/${submitted.receipt.receiptId}/artifact`)).text(), 'New independent artifact');
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.ROOM_RESULTS_SCREENSHOT_DIR) await f.page.screenshot({ path: `${process.env.ROOM_RESULTS_SCREENSHOT_DIR}/owner-follow-up-result-${width}.png`, fullPage: true });
});
test('lost committed follow-up retries exact public terms without creating another child', { timeout: 45000 }, async t => {
  const f = await setup(t), form = await prepareFollowUp(f), payloads = []; let lose = true;
  await f.page.route('**/public-work/receipts/*/follow-up', async route => { payloads.push(route.request().postData()); const response = await route.fetch(); assert.equal(response.status(), 200); if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ response }); });
  await form.locator('[name=publicConfirm]').check(); await form.getByRole('button', { name: 'Publish follow-up' }).click(); await f.page.locator('#owner-offer-retry').waitFor();
  assert.equal(await form.locator('[name=title]').isDisabled(), true); assert.equal(await form.locator('[name=summary]').inputValue(), 'Publicly requested improvement');
  const pointer = f.store.publicWorkSuccessors.link(f.receipt.receiptId); assert.ok(pointer);
  f.store.projectOffers.transition('commons', 'owner', pointer.taskId, 'withdraw', { requestId: 'withdraw-lost-child', expectedRevision: 2 });
  await f.page.locator('#owner-offer-retry').click(); await followUpRecorded(f); assert.equal(payloads.length, 2); assert.equal(payloads[0], payloads[1]);
  await row(f).getByText('Follow-up unavailable.', { exact: true }).waitFor();
  assert.equal(await row(f).getByRole('link', { name: 'View follow-up' }).count(), 0);
  assert.deepEqual(f.store.publicWorkSuccessors.link(f.receipt.receiptId), { ...pointer, available: false });
  assert.equal(f.store.projectOffers.ownerList('commons', 'owner').offers.filter(offer => offer.title.startsWith('Explicit follow-up')).length, 1);
});
test('ended account session fences a held committed follow-up and clears private terms', { timeout: 45000 }, async t => {
  const f = await setup(t), form = await prepareFollowUp(f); let release, observed;
  const held = new Promise(resolve => { release = resolve; }), captured = new Promise(resolve => { observed = resolve; }); t.after(() => release());
  await f.page.route('**/public-work/receipts/*/follow-up', async route => { const response = await route.fetch(); assert.equal(response.status(), 200); observed(); await held; await route.fulfill({ response }); });
  await form.locator('[name=publicConfirm]').check(); await form.getByRole('button', { name: 'Publish follow-up' }).click(); await captured;
  const cookie = (await f.page.context().cookies()).find(cookie => cookie.name === 'account_session'); assert.ok(cookie); f.store.logoutAccountSession(cookie.value, f.store.accountSessionSlot(cookie.value).sessionRevision);
  await f.page.locator('#refresh-button').click(); await f.page.locator('#main').waitFor({ state: 'hidden' });
  const delivered = f.page.waitForEvent('requestfinished', request => request.url().endsWith('/follow-up')); release(); await delivered;
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('#owner-results-list').textContent(), ''); assert.equal(await form.locator('[name=summary]').inputValue(), ''); assert.equal(await f.page.locator('#owner-follow-up-context').textContent(), '');
  assert.equal(await f.page.locator('#owner-offers-open').isVisible(), false);
  assert.ok(f.store.publicWorkSuccessors.link(f.receipt.receiptId), 'the real committed public task remains distinct from the ended private UI');
});
test('edge-door owner follow-up links open the canonical supported offers route', { timeout: 45000 }, async t => {
  const f = await setup(t), form = await prepareFollowUp(f);
  await form.locator('[name=publicConfirm]').check(); await form.getByRole('button', { name: 'Publish follow-up' }).click(); await followUpRecorded(f);
  // Replay reads through the existing /room proxy rewrite locally. Mutation
  // lifecycle is covered above; this keeper owns rendered edge-host links.
  const door = 'http://www.getdasha.com';
  await f.page.context().addCookies((await f.page.context().cookies()).map(cookie => ({ ...cookie, domain: 'www.getdasha.com' })));
  await f.page.route(`${door}/**`, route => {
    const url = new URL(route.request().url()); const path = url.pathname.replace(/^\/room(?=\/|$)/, '') || '/';
    if (path.endsWith('/stream')) return route.abort(); // This bounded read/link keeper does not proxy an infinite SSE response.
    return route.fetch({ url: f.origin + path + url.search, headers: { ...route.request().headers(), host: new URL(f.origin).host, origin: f.origin } }).then(response => route.fulfill({ response }));
  });
  await f.page.routeWebSocket('**', socket => socket.close());
  await f.page.goto(`${door}/room/?room=commons`); await f.page.locator('#main').waitFor({ state: 'visible' }); await open(f);
  await row(f).getByRole('link', { name: 'View follow-up' }).waitFor();
  const pointer = f.store.publicWorkSuccessors.link(f.receipt.receiptId);
  assert.equal(await row(f).getByRole('link', { name: 'View follow-up' }).getAttribute('href'), `https://room.trydemigod.com/offers?offer=${pointer.taskId}`);
  const publicLinks = await f.page.locator('#owner-offers-list').getByRole('link', { name: 'View public offer' }).evaluateAll(links => links.map(link => link.href));
  assert.ok(publicLinks.includes(`https://room.trydemigod.com/offers?offer=${pointer.taskId}`));
  assert.equal(publicLinks.some(link => new URL(link).pathname === '/room/offers'), false);
});
