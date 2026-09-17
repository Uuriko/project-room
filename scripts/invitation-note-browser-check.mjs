// Disposable synthetic journeys. These are not retention or human-study evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function setup(t, touch = false) {
  const fixture = createAcceptanceFixture(), server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1360, height: 1000 },
    hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async value => {
      (window.noteCopies ||= []).push(value);
      if (window.noteCopyMode === 'reject') throw new Error('Synthetic clipboard rejection');
      if (window.noteCopyMode === 'hold') await new Promise((resolve, reject) => {
        window.finishNoteCopy = outcome => outcome === 'resolve' ? resolve() : reject(new Error('Synthetic delayed rejection'));
      });
    } }
  }));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  await page.goto(origin); await page.locator('#access-key').fill(fixture.keys.owner);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#invite-people-button').click();
  return { fixture, origin, page, errors, requests };
}
async function create(page) {
  await page.locator('#share-link-create').click();
  await page.locator('#share-link-result').waitFor({ state: 'visible' });
  return page.locator('#share-link-url').inputValue();
}
async function note(page, text = 'Can you review the welcome screen? No rush.') {
  if (!await page.locator('#share-note').evaluate(el => el.open)) await page.locator('#share-note > summary').click();
  await page.locator('#share-note-text').fill(text);
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(page, name) {
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/invitation-note-${name}.png`,
    mask: [page.locator('#access-key'), page.locator('#share-link-url'), page.locator('#share-note-preview')], maskColor: '#263341' });
}

for (const touch of [false, true]) test(`optional invitation note ${touch ? 'mobile' : 'desktop'}: exact, private, keyboard-friendly composition`, { timeout: 45000 }, async t => {
  const { page, fixture, errors, requests } = await setup(t, touch);
  const url = await create(page), mode = touch ? 'mobile' : 'desktop';
  assert.equal(await page.locator('#share-note').evaluate(el => el.open), false);
  assert.equal(await page.locator('#share-note-text').inputValue(), '');
  await capture(page, `${mode}-closed`);
  await page.locator('#share-link-copy').click();
  assert.equal(await page.evaluate(() => window.noteCopies.at(-1)), url);
  const sentinel = 'SYNTHETIC-NOTE-ONLY';
  await note(page, `  ${sentinel} <b>literal</b> 💡`);
  await page.locator('#share-note-text').press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Could you review one screen?  ');
  const draft = await page.locator('#share-note-text').inputValue();
  assert.ok(draft.includes('\n'), 'Enter is a newline, not a submit');
  const expected = `${draft.trim()}\n\n${url}`;
  assert.equal(await page.locator('#share-note-preview').inputValue(), expected);
  assert.equal(await page.locator('#share-note b').count(), 0, 'markup remains literal text');
  await page.locator('#share-note-copy').click();
  await page.waitForFunction(() => document.querySelector('#share-link-status').textContent === 'Invitation copied.');
  assert.equal(await page.evaluate(() => window.noteCopies.at(-1)), expected);
  await page.locator('#share-link-copy').click();
  assert.equal(await page.evaluate(() => window.noteCopies.at(-1)), url, 'default copy never includes the note');
  await page.locator('#share-note > summary').click(); await page.locator('#share-note > summary').click();
  assert.equal(await page.locator('#share-note-text').inputValue(), draft, 'disclosure collapse retains this draft');
  await page.evaluate(() => { window.noteCopyMode = 'reject'; });
  await page.locator('#share-note-copy').click();
  await page.waitForFunction(() => document.querySelector('#share-link-status').textContent === 'Select and copy the preview above.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'share-note-preview');
  assert.equal(await page.locator('#share-note-preview').evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), expected);
  assert.equal(await page.locator('#share-note-text').inputValue(), draft);
  assert.equal(requests.some(request => request.includes(sentinel)), false);
  assert.equal(await page.evaluate(value => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes(value), sentinel), false);
  assert.equal(JSON.stringify(fixture.store.room('commons')).includes(sentinel), false);
  assert.equal(requests.filter(request => request.includes('"linkToken"')).length, 1, 'note input makes no new creation or message request');
  await note(page); await capture(page, `${mode}-expanded`);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#share-note-text').scrollIntoViewIfNeeded(); await capture(page, `${mode}-large-text`);
  await page.locator('#share-note-copy').focus(); await page.locator('#share-note-copy').scrollIntoViewIfNeeded();
  await settle(page); await capture(page, `${mode}-large-text-controls`);
  assert.equal(await page.locator('#share-note-copy').evaluate(el => {
    const box = el.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el;
  }), true, 'enlarged copy control is reachable at its visible position');
  assert.equal(await page.locator('#share-link-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  assert.ok((await page.locator('#share-note-copy').boundingBox()).height >= 44);
  await page.locator('#share-link-close').click();
  await page.locator('#share-link-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#share-note-text').value === '');
  assert.equal(await page.locator('#share-note-preview').inputValue(), '');
  assert.deepEqual(errors, []);
});

for (const outcome of ['resolve', 'reject']) for (const change of ['A-B-A draft', 'replacement link', 'close']) {
  test(`delayed invitation copy ${outcome} after ${change}: one flight and no stale feedback`, { timeout: 30000 }, async t => {
    const { page, errors } = await setup(t);
    await create(page); await note(page, 'Original draft');
    await page.evaluate(() => { window.noteCopyMode = 'hold'; });
    await page.locator('#share-note-copy').click();
    await page.waitForFunction(() => typeof window.finishNoteCopy === 'function');
    assert.equal(await page.locator('#share-link-copy').isDisabled(), true);
    assert.equal(await page.locator('#share-note-copy').isDisabled(), true);
    await page.locator('#share-link-copy').dispatchEvent('click');
    await page.locator('#share-note-copy').dispatchEvent('click');
    assert.equal(await page.evaluate(() => window.noteCopies.length), 1);
    if (change === 'A-B-A draft') { await note(page, 'New draft'); await note(page, 'Original draft'); }
    if (change === 'replacement link') {
      await page.locator('#share-link-another').click();
      assert.equal(await page.locator('#share-note-text').inputValue(), '');
      await create(page); await note(page, 'Replacement draft');
      assert.equal(await page.locator('#share-note-copy').isDisabled(), true, 'old write must settle before another can start');
    }
    if (change === 'close') {
      await page.locator('#share-link-close').click();
      await page.locator('#share-link-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('#share-note-text').value === '');
    } else await page.locator('#share-management-summary').focus();
    const feedback = await page.locator('#share-link-status').textContent(), focus = await page.evaluate(() => document.activeElement.id);
    await page.evaluate(value => window.finishNoteCopy(value), outcome); await settle(page);
    assert.equal(await page.locator('#share-link-status').textContent(), feedback);
    assert.equal(await page.evaluate(() => document.activeElement.id), focus);
    if (change !== 'close') assert.equal(await page.locator('#share-note-copy').isEnabled(), true);
    assert.deepEqual(errors, []);
  });
}

test('unknown current-link cancellation clears its note; retrying the older link preserves a replacement', { timeout: 30000 }, async t => {
  const { page, errors } = await setup(t);
  await create(page); await note(page);
  const oldId = await page.locator('#share-link-url').getAttribute('data-link-id');
  await page.locator('#share-management-summary').click();
  const row = page.locator(`#share-link-list li[data-link-id="${oldId}"]`);
  await row.waitFor();
  let cancellations = 0;
  await page.route('**/api/rooms/commons/share-links-cancel', async route => {
    if (++cancellations === 1) await route.abort('failed'); else await route.continue();
  });
  await row.getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('#share-management-status').textContent.includes('could not confirm cancellation'));
  assert.equal(await page.locator('#share-link-result').isVisible(), false);
  assert.equal(await page.locator('#share-note-text').inputValue(), '');
  await create(page); await note(page, 'Replacement note');
  const replacementUrl = await page.locator('#share-link-url').inputValue();
  await row.getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('#share-management-status').textContent.startsWith('Link cancelled.'));
  assert.equal(cancellations, 2);
  assert.equal(await page.locator('#share-link-url').inputValue(), replacementUrl);
  assert.equal(await page.locator('#share-note-text').inputValue(), 'Replacement note');
  assert.deepEqual(errors, []);
});

test('known expiry clears a focused note and restores a reachable creation control', { timeout: 15000 }, async t => {
  const { page, errors } = await setup(t);
  await page.route('**/api/rooms/commons/share-links', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(), body = await response.json();
    body.link.expiresAt = Date.now() + 1500;
    await route.fulfill({ response, json: body });
  });
  await create(page); await note(page);
  await page.locator('#share-note-text').focus();
  await page.locator('#share-link-result').waitFor({ state: 'hidden' });
  await settle(page);
  assert.equal(await page.locator('#share-link-status').textContent(), 'This link is no longer active. Create a new link.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'share-link-create');
  assert.equal(await page.locator('#share-note-text').inputValue(), '');
  assert.equal(await page.locator('#share-note-preview').inputValue(), '');
  assert.deepEqual(errors, []);
});

for (const change of ['collapse', 'focus move']) test(`invitation copy failure after ${change} respects the latest interaction`, { timeout: 15000 }, async t => {
  const { page, errors } = await setup(t);
  await create(page); await note(page);
  await page.evaluate(() => { window.noteCopyMode = 'hold'; });
  await page.locator('#share-note-copy').click();
  await page.waitForFunction(() => typeof window.finishNoteCopy === 'function');
  await page.locator('#share-management-summary').focus();
  await page.evaluate(value => {
    // Collapse synchronously before the queued native toggle notification.
    if (value === 'collapse') document.querySelector('#share-note').open = false;
    window.finishNoteCopy('reject');
  }, change);
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'share-management-summary');
  const feedback = await page.locator('#share-link-status').textContent();
  assert.equal(feedback, change === 'collapse' ? '' : 'Select and copy the preview above.');
  assert.equal(await page.locator('#share-note-copy').isEnabled(), true);
  assert.deepEqual(errors, []);
});
