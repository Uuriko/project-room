import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

for (const width of [1360, 390]) test(`file recovery and uncertain retry at ${width}px`, { timeout: 30000 }, async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store });
  let browser;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#access-key').fill(token);
  await page.getByRole('button', { name: 'Enter room', exact: true }).click();
  await page.locator('#main').waitFor({ state: 'visible' });
  await page.locator('#composer-options > summary').click();
  await page.locator('#remember-drafts').check();
  await page.locator('#file-picker').setInputFiles({ name: 'recover.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
  await page.locator('#composer-files').getByText('Ready', { exact: true }).waitFor();
  await page.reload();
  await page.locator('#composer-files').getByText('Ready', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-input').inputValue(), '');
  assert.equal(store.room('commons').state.messages.length, 0);
  const attempts = [];
  await page.route('**/commands', async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#composer-status').filter({ hasText: 'Draft kept' }).waitFor();
  assert.equal(store.room('commons').state.messages.length, 1);
  await page.route('**/attachments/*/status', route => route.fulfill({ status: 503, json: { error: { message: 'Status unavailable' } } }));
  await page.reload();
  await page.locator('#composer-files').getByText('Status unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('#message-input').evaluate(e => e.readOnly), true);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#composer-files .composer-file').length === 0);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(store.room('commons').state.messages.length, 1);
  assert.deepEqual(errors, []);
});
