// Synthetic recovery regressions in disposable loopback rooms, not human-study evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t, { touch = false, clipboard = false } = {}) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const releases = [];
  let browser;
  t.after(async () => {
    for (const release of releases) release();
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({
    viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 900 },
    hasTouch: touch, isMobile: touch, reducedMotion: 'reduce'
  });
  if (clipboard) await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => new Promise((resolve, reject) => {
      window.finishTestClipboard = outcome => outcome === 'resolve'
        ? resolve() : reject(new Error('Synthetic delayed clipboard rejection'));
    }) }
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { fixture, origin, page, errors, releases };
}

async function ownerPage(page, origin, fixture) {
  await page.goto(origin);
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  await page.locator('#access-key').fill(fixture.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#invite-people-button').click();
}

async function createLink(page) {
  await page.locator('#share-link-create').click();
  await page.locator('#share-link-result').waitFor({ state: 'visible' });
  return page.locator('#share-link-url').getAttribute('data-link-id');
}

async function settleRendering(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function capture(page, name) {
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/invitation-recovery-${name}.png`,
    mask: [page.locator('#access-key'), page.locator('#share-link-url')] });
}

test('guest sign-out recovery locks the current invitation and can join after confirmation', { timeout: 45000 }, async t => {
  const { fixture, origin, page, errors, releases } = await setup(t);
  let joins = 0, signingOut = false;
  const restoring = Promise.withResolvers(), release = Promise.withResolvers();
  releases.push(release.resolve);
  await page.route('**/api/share-links/join', async route => {
    if (++joins === 1) await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
      error: { code: 'guest_session_ended', message: 'Synthetic expired guest: sign out to join again.' }
    }) });
    else await route.continue();
  });
  await page.route('**/api/account-session', async route => {
    if (signingOut && route.request().method() === 'GET') {
      restoring.resolve(); await release.promise;
    }
    await route.continue();
  });
  await page.goto(`${origin}/#join/${fixture.links.valid}`);
  await page.locator('#join-link-name').fill('Test recovered guest');
  await page.locator('#join-link-submit').click();
  await page.locator('#join-link-signout').waitFor({ state: 'visible' });
  signingOut = true;
  await page.locator('#join-link-signout').click(); await restoring.promise;
  for (const id of ['name', 'submit', 'close', 'signout']) assert.equal(await page.locator('#join-link-' + id).isEnabled(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#join-link-dialog').isVisible(), true);
  await page.evaluate(token => { location.hash = '#join/' + token; }, fixture.links.full);
  await page.waitForFunction(() => location.hash === '');
  release.resolve();
  await page.waitForFunction(() => document.querySelector('#join-link-status').textContent.startsWith('Signed out.'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'join-link-name');
  assert.equal(await page.locator('#join-link-name').inputValue(), 'Test recovered guest');
  await page.locator('#join-link-submit').click();
  await page.locator('#main').waitFor({ state: 'visible' });
  assert.match(await page.locator('#identity-label').textContent(), /Test recovered guest/);
  assert.equal(joins, 2);
  assert.deepEqual(errors, []);
});

for (const failure of ['network', '429', '503']) {
  test(`invitation preview ${failure}: repeated failure keeps a usable retry and the same secret`, { timeout: 45000 }, async t => {
    const { fixture, origin, page, errors, releases } = await setup(t, { touch: failure === 'network' });
    const previews = [];
    let joins = 0;
    const secondRequest = Promise.withResolvers(), releaseSecond = Promise.withResolvers();
    releases.push(releaseSecond.resolve);
    await page.route('**/api/share-links/preview', async route => {
      previews.push(route.request().postDataJSON().linkToken);
      if (previews.length === 2) { secondRequest.resolve(); await releaseSecond.promise; }
      if (previews.length <= 2) {
        if (failure === 'network') await route.abort('failed');
        else await route.fulfill({ status: Number(failure), contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'synthetic_preview_unavailable', message: 'Synthetic temporary preview failure.' } }) });
      } else await route.continue();
    });
    await page.route('**/api/share-links/join', async route => { joins++; await route.continue(); });
    await page.goto(`${origin}/#join/${fixture.links.valid}`);
    const retry = page.locator('#join-link-retry');
    await retry.waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).hash, '', 'preview removes the invitation fragment');
    assert.equal(await page.locator('#join-link-form').isVisible(), false);
    assert.equal(joins, 0, 'preview failure does not join');
    if (failure === 'network') await capture(page, 'preview-error-touch');
    await retry.click(); await secondRequest.promise;
    // A later failure must not override an explicit focus move made while waiting.
    if (failure === 'network') await page.locator('#join-link-close').focus();
    releaseSecond.resolve();
    await retry.waitFor({ state: 'visible' });
    await settleRendering(page);
    assert.equal(await retry.isEnabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id),
      failure === 'network' ? 'join-link-close' : 'join-link-retry');
    assert.equal(joins, 0, 'retrying preview still does not join');
    await retry.click();
    await page.locator('#join-link-form').waitFor({ state: 'visible' });
    assert.equal(await retry.isVisible(), false);
    assert.equal(previews.length, 3);
    assert.equal(previews.every(token => token === fixture.links.valid), true, 'all preview attempts retain the original secret');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(joins, 0, 'successful preview needs a separate join submission');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'join-link-name');
    if (failure === 'network') await capture(page, 'preview-ready-touch');
    await page.locator('#join-link-name').fill('Recovery test guest');
    await page.locator('#join-link-submit').click();
    await page.locator('#main').waitFor({ state: 'visible' });
    assert.equal(joins, 1);
    assert.equal(await page.locator('#identity-label').textContent(), 'Recovery test guest');
    assert.deepEqual(errors, []);
  });
}

for (const failure of ['malformed', 'expired']) {
  test(`invitation preview ${failure}: permanent failure does not advertise Retry`, { timeout: 30000 }, async t => {
    const { fixture, origin, page, errors } = await setup(t);
    let previews = 0, joins = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/share-links/preview') previews++;
      if (new URL(request.url()).pathname === '/api/share-links/join') joins++;
    });
    await page.goto(`${origin}/#join/${failure === 'expired' ? fixture.links.expired : 'invalid-invitation'}`);
    await page.waitForFunction(() => /incomplete|Unable to open/.test(document.querySelector('#join-link-scope').textContent));
    assert.equal(await page.locator('#join-link-retry').isVisible(), false);
    assert.equal(await page.locator('#join-link-form').isVisible(), false);
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(previews, failure === 'malformed' ? 0 : 1);
    assert.equal(joins, 0);
    assert.deepEqual(errors, []);
  });
}

for (const outcome of ['resolve', 'reject']) {
  for (const replacement of [false, true]) {
    test(`clipboard ${outcome} after ${replacement ? 'replacement link' : 'New link'}: stale feedback cannot own current controls`, { timeout: 30000 }, async t => {
      const { fixture, origin, page, errors } = await setup(t, { clipboard: true, touch: outcome === 'reject' });
      await ownerPage(page, origin, fixture);
      const originalId = await createLink(page);
      await page.locator('#share-link-copy').click();
      await page.waitForFunction(() => typeof window.finishTestClipboard === 'function');
      await page.locator('#share-link-another').click();
      if (replacement) assert.notEqual(await createLink(page), originalId, 'a new result has a different identity');
      else assert.equal(await page.locator('#share-link-result').isVisible(), false);
      await page.locator('#share-management-summary').focus();
      const currentStatus = await page.locator('#share-link-status').textContent();
      assert.equal(currentStatus, replacement ? 'Link ready.' : '');
      await page.evaluate(value => window.finishTestClipboard(value), outcome);
      await settleRendering(page);
      assert.equal(await page.locator('#share-link-status').textContent(), currentStatus);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'share-management-summary');
      assert.equal(await page.locator('#share-link-result').isVisible(), replacement);
      if (replacement && outcome === 'reject') await capture(page, 'clipboard-replacement-touch');
      assert.deepEqual(errors, []);
    });
  }
}

for (const moveFocus of [false, true]) {
  test(`cancelled link with failed list reload: ${moveFocus ? 'preserves newer focus' : 'restores management focus'}`, { timeout: 30000 }, async t => {
    const { fixture, origin, page, errors, releases } = await setup(t, { touch: !moveFocus });
    await ownerPage(page, origin, fixture);
    const linkId = await createLink(page);
    await page.locator('#share-management-summary').click();
    const row = page.locator(`#share-link-list li[data-link-id="${linkId}"]`);
    await row.waitFor();
    const reload = Promise.withResolvers(), release = Promise.withResolvers(), delivered = Promise.withResolvers();
    releases.push(release.resolve);
    await page.route('**/api/rooms/commons/share-links', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      reload.resolve(); await release.promise;
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'synthetic_list_unavailable', message: 'Synthetic list reload failure.' } }) });
      delivered.resolve();
    });
    await row.getByRole('button', { name: /^Cancel link/ }).focus();
    await page.keyboard.press('Enter'); await reload.promise;
    assert.equal(await page.locator('#share-link-result').isVisible(), false);
    if (moveFocus) await page.locator('#share-link-close').focus();
    release.resolve(); await delivered.promise;
    await page.waitForFunction(() => document.querySelector('#share-management-status').textContent.includes('Synthetic list reload failure.'));
    await settleRendering(page);
    const status = await page.locator('#share-management-status').textContent();
    assert.match(status, /^Link cancelled\. Existing members keep their access\./);
    assert.equal(await page.evaluate(() => document.activeElement.id), moveFocus ? 'share-link-close' : 'share-management-summary');
    assert.equal(await row.getByRole('button', { name: /^Cancel link/ }).isDisabled(), true);
    const description = await row.locator('p').textContent();
    assert.match(description, / · cancelled · /, 'the retained row reflects confirmed cancellation despite reload failure');
    assert.doesNotMatch(description, / · active · /, 'a confirmed cancelled link cannot retain an active row label');
    assert.equal(fixture.store.shareLinks.list(fixture.keys.owner, 'commons', null).links.find(link => link.id === linkId).status, 'cancelled');
    assert.equal(await page.locator('#share-management').evaluate(el => el.open), true);
    if (!moveFocus) await capture(page, 'cancel-confirmed-list-error-touch');
    assert.deepEqual(errors, []);
  });
}
