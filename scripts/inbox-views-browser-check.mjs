import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

test('Inbox splits/search preserve drafts and clear private search on sign-out', async t => {
  const f = createAcceptanceFixture();
  const account = f.store.accountForMember('commons', 'owner');
  const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  for (const id of ['email-one', 'message-one']) f.store.inbox.apply(slot.token, {
    action: 'source.save', requestId: id, sourceId: id, expectedRevision: 0,
    data: { adapter: 'synthetic', sender: id, recipient: 'test', subject: id, paragraphs: ['Synthetic test body'] }
  }, session.sessionBinding);
  // Fixture-only projection of future connector types; no real messaging import claimed.
  const list = f.store.inbox.list.bind(f.store.inbox);
  f.store.inbox.list = (...args) => { const result = list(...args); result.sources.forEach(source => { source.adapter = source.id.startsWith('email') ? 'email' : 'message'; }); return result; };
  const server = createRoomServer({ store: f.store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?account=1`);
  await page.locator('#sign-in-entry').click(); await page.locator('#access-key').fill(key);
  await page.locator('#auth-form button[type=submit]').click(); await page.locator('#inbox-list .inbox-row').first().waitFor();
  assert.equal(await page.locator('#inbox-list .inbox-row').count(), 2);
  await page.locator('[data-inbox-view=email]').click();
  await page.locator('#inbox-subject').getByText('email-one', { exact: true }).waitFor();
  await page.locator('#inbox-draft').fill('Keep this unsaved private draft');
  await page.locator('[data-inbox-view=messages]').click();
  await page.locator('#inbox-subject').getByText('message-one', { exact: true }).waitFor();
  assert.equal(await page.locator('#inbox-list .inbox-row').count(), 1);
  await page.locator('[data-inbox-view=email]').click();
  assert.equal(await page.locator('#inbox-draft').inputValue(), 'Keep this unsaved private draft');
  await page.locator('#inbox-search').fill('no matching private query');
  assert.equal(await page.locator('#inbox-reader').isVisible(), false);
  assert.equal(await page.locator('#inbox-list .inbox-row').count(), 0);
  await page.locator('#inbox-search').fill('email');
  await page.locator('#inbox-reader').waitFor({ state: 'visible' });
  page.on('dialog', dialog => dialog.accept()); await page.locator('#signout-button').click();
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#inbox-search').inputValue(), ''); assert.deepEqual(errors, []);
});
