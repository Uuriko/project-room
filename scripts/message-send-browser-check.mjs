import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';

async function setup(t, mobile = false) {
  const f = createAcceptanceFixture();
  f.store.command(f.keys.owner, 'commons', { id: crypto.randomUUID(), type: 'channel.created', data: { channelId: 'design', name: 'design' } });
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  page.on('dialog', dialog => dialog.accept());
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await signInFixture(page, f.keys.owner);
  await page.locator('#main').waitFor({ state: 'visible' });
  return page;
}

for (const mobile of [false, true]) test(`message echo before receipt; composer releases before snapshot (${mobile ? 'phone' : 'desktop'})`, { timeout: 30000 }, async t => {
  const p = await setup(t, mobile), input = p.locator('#message-input');
  let releaseReceipt, releaseSnapshot;
  const receiptGate = new Promise(r => releaseReceipt = r), snapshotGate = new Promise(r => releaseSnapshot = r);
  let command;
  await p.route('**/api/rooms/*', async route => {
    if (route.request().method() === 'GET') { await snapshotGate; }
    await route.continue();
  });
  await p.route('**/api/rooms/*/commands', async route => {
    command = route.request().postDataJSON(); await receiptGate; await route.continue();
  });
  t.after(() => { releaseReceipt(); releaseSnapshot(); });
  await input.fill('Instant original message');
  const latency = await input.evaluate(node => new Promise(resolve => {
    const start = performance.now();
    const observer = new MutationObserver(() => { if (document.querySelector('[data-local-message-id]')) { observer.disconnect(); resolve(performance.now() - start); } });
    observer.observe(document.querySelector('#message-list'), { childList: true });
    node.form.requestSubmit();
  }));
  t.diagnostic(`Local echo appeared in ${latency.toFixed(1)}ms`);
  assert.ok(latency < 100, `local echo took ${latency}ms`);
  const echo = p.locator('[data-local-message-id]');
  assert.equal(await echo.count(), 1); assert.match(await echo.textContent(), /Instant original message/);
  assert.doesNotMatch(await echo.textContent(), /Sending|Sent/);
  assert.equal(await echo.getAttribute('aria-busy'), 'true'); assert.equal(await input.isDisabled(), true);
  releaseReceipt();
  await p.waitForFunction(() => !document.querySelector('#message-input').disabled);
  assert.equal(await input.inputValue(), ''); assert.equal(await echo.count(), 1);
  assert.equal(await echo.getAttribute('aria-busy'), 'false');
  assert.equal(await echo.evaluate(node => getComputedStyle(node).opacity), '1', 'receipt removes pending appearance before snapshot');
  await input.fill('Next draft stays');
  releaseSnapshot();
  await p.locator(`[data-message-record-id="${command.data.messageId}"]`).waitFor();
  assert.equal(await echo.count(), 0); assert.equal(await input.inputValue(), 'Next draft stays');
  assert.equal(await p.locator(`[data-message-record-id="${command.data.messageId}"]`).count(), 1);
});

test('failed message retains exact retry; sign out removes ephemeral content', { timeout: 30000 }, async t => {
  const p = await setup(t), input = p.locator('#message-input'), commands = [];
  let releaseRetry; const gate = new Promise(r => releaseRetry = r); t.after(() => releaseRetry());
  await p.route('**/api/rooms/*/commands', async route => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Try again' } }) });
    await gate; await route.continue();
  });
  await input.fill('Retain my exact retry'); await input.press('Enter');
  await p.locator('#composer-status.visible').waitFor();
  await p.waitForFunction(() => !document.querySelector('#message-input').disabled);
  assert.equal(await input.inputValue(), 'Retain my exact retry');
  assert.equal(await p.locator('[data-local-message-id]').count(), 0);
  await input.press('Enter'); await p.locator('[data-local-message-id]').waitFor();
  await p.waitForFunction(() => document.querySelector('#message-input').disabled);
  assert.equal(commands.length, 2);
  releaseRetry();
  await p.waitForFunction(() => !document.querySelector('#message-input').disabled);
  await p.locator('#signout-button').evaluate(node => node.click());
  await p.locator('#main').waitFor({ state: 'hidden' });
  assert.deepEqual(commands[1], commands[0]);
  assert.equal(await p.locator('[data-local-message-id]:visible').count(), 0);
});


test('confirmed preview survives refresh failure, stays in its channel and clears on sign out', { timeout: 30000 }, async t => {
  const p = await setup(t), input = p.locator('#message-input');
  await p.route('**/api/rooms/*', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Snapshot temporarily unavailable' } }) }) : route.continue());
  await input.fill('Committed despite slow room refresh'); await input.press('Enter');
  await p.locator('[data-local-message-id][aria-busy="false"]').waitFor();
  await p.waitForFunction(() => !document.querySelector('#message-input').disabled);
  assert.equal(await input.inputValue(), '');
  assert.equal(await p.locator('#composer-status').textContent(), '');
  await p.locator('[data-channel="design"]').evaluate(node => node.click());
  assert.equal(await p.locator('[data-local-message-id]').count(), 0);
  await input.fill('Design draft');
  await p.locator('[data-channel="general"]').evaluate(node => node.click());
  assert.equal(await p.locator('[data-local-message-id]').count(), 1);
  assert.equal(await input.inputValue(), '');
  await p.locator('[data-channel="design"]').evaluate(node => node.click());
  assert.equal(await input.inputValue(), 'Design draft');
  await p.locator('#signout-button').evaluate(node => node.click());
  await p.locator('#main').waitFor({ state: 'hidden' });
  assert.equal(await p.locator('[data-local-message-id]').count(), 0);
});

test('legacy Ask Room has immediate local echo before message receipt', { timeout: 30000 }, async t => {
  const p = await setup(t), input = p.locator('#message-input');
  // Model an older deployment without atomic-admission capability.
  await p.route('**/api/rooms/*/assistant', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(), body = await response.json();
    delete body.capabilities;
    await route.fulfill({response, json:body});
  });
  await p.reload(); await p.locator('#main').waitFor({state:'visible'});
  let release;
  const gate = new Promise(resolve => release = resolve);
  t.after(() => release());
  await p.route('**/api/rooms/*/commands', async route => { await gate; await route.continue(); });
  await p.locator('#ask-room').click();
  await input.fill('Room, please review this');
  await input.press('Enter');
  const echo = p.locator('[data-local-message-id]');
  await echo.waitFor();
  assert.equal(await echo.count(), 1);
  assert.match(await echo.textContent(), /Room, please review this/);
  assert.equal(await echo.getAttribute('aria-busy'), 'true');
  release();
  await p.waitForFunction(() => !document.querySelector('#message-input').disabled);
  assert.match(await p.locator('#assistant-error').textContent(), /rejected|not confirmed/i, 'unconfigured host is not presented as working');
});
