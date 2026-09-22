import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { gmailLiveFixture } from './gmail-live-fixture.mjs';
import { GmailMailbox } from '../server/gmail-mailbox.mjs';
import { createRoomServer } from '../server/http.mjs';
import { fillAccessKey } from './auth-signin.mjs';
for (const width of [390, 1440]) test(`Gmail compose, save, reply, send, triage and search at ${width}px`, { timeout: 35000 }, async t => {
  const f = createAcceptanceFixture(), provider = gmailLiveFixture(), account = f.store.accountForMember('commons', 'owner');
  f.store.completeOnboarding(account.id); const key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, key, 0), m = new GmailMailbox(f.store, provider.config);
  const url = new URL(m.begin(slot.token, session.sessionBinding)); url.host = 'room.example'; url.pathname = '/api/auth/gmail/callback'; url.searchParams.set('code', 'fixture'); await m.complete(url, url.searchParams.get('state'));
  const server = createRoomServer({ store: f.store, gmailAuth: provider.config }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width, height: 950 } }), page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/?account=1'); await fillAccessKey(page, key); await page.locator('#auth-form button[type=submit]').click();
  await page.locator('#inbox-gmail-open').click(); const root = page.locator('.gmail-workspace'), dialog = page.locator('.gmail-compose');
  await root.getByRole('button', { name: 'Taylor' }).click(); await root.locator('[data-reader]').getByText('Meet at noon.', { exact: true }).waitFor();
  await root.getByRole('button', { name: 'Reply', exact: true }).click(); await dialog.getByLabel('Message', { exact: true }).fill('Friday works.');
  await dialog.getByRole('button', { name: 'Save to Gmail drafts' }).click(); await dialog.getByText('Saved to Gmail drafts.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await root.getByLabel('Folder').selectOption('drafts');
  await root.locator('.gmail-message').click(); await root.getByRole('button', { name: 'Edit draft' }).click(); assert.equal(await dialog.getByLabel('Message', { exact: true }).inputValue(), 'Friday works.');
  await dialog.getByLabel('Message', { exact: true }).fill('Friday works. See you then.'); await dialog.getByRole('button', { name: 'Send email', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(provider.calls.filter(c => c.url.endsWith('/drafts/send')).length, 1);
  await root.getByLabel('Folder').selectOption('sent'); await root.locator('.gmail-message').click(); await root.locator('[data-reader]').getByText('Friday works. See you then.', { exact: true }).waitFor();
  await root.getByRole('button', { name: 'New email' }).click(); await dialog.getByLabel('To', { exact: true }).fill('friend@example.com'); await dialog.getByLabel('Subject', { exact: true }).fill('New note'); await dialog.getByLabel('Message', { exact: true }).fill('Hello from Project Room.');
  await dialog.getByText('Cc / Bcc', { exact: true }).click(); await dialog.getByLabel('Cc', { exact: true }).fill('copy@example.com');
  mkdirSync('test-results/gmail-workspace', { recursive: true }); await page.screenshot({ path: `test-results/gmail-workspace/compose-${width}.png`, fullPage: true });
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await dialog.getByRole('button', { name: 'Send email', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(provider.calls.filter(c => c.url.endsWith('/messages/send')).length, 1);
  await root.getByLabel('Folder').selectOption('inbox'); await root.locator('.gmail-message').click(); await root.getByRole('button', { name: 'Star', exact: true }).click(); await root.getByRole('button', { name: 'Unstar', exact: true }).waitFor();
  await root.getByRole('button', { name: 'Archive', exact: true }).click(); await root.getByLabel('Folder').selectOption('all'); await root.getByLabel('Search Gmail').fill('New note'); await root.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gmail-message').length === 1 && document.querySelector('.gmail-message').textContent.includes('New note'));
  await page.screenshot({ path: `test-results/gmail-workspace/mailbox-${width}.png`, fullPage: true });
  assert.ok(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  // Lose the HTTP receipt after Gmail has accepted the message. The browser
  // must check the same durable request, never generate another send.
  let lost = false;
  await page.route('**/api/inbox/gmail/mailbox', async route => {
    const request = route.request().postDataJSON();
    if (request.action === 'send' && !lost) { lost = true; await route.fetch(); await route.abort(); }
    else await route.continue();
  });
  await root.getByRole('button', { name: 'New email' }).click();
  await dialog.getByLabel('To', { exact: true }).fill('friend@example.com'); await dialog.getByLabel('Subject', { exact: true }).fill('Receipt test'); await dialog.getByLabel('Message', { exact: true }).fill('Send once.');
  await dialog.getByRole('button', { name: 'Send email', exact: true }).click(); await dialog.getByRole('button', { name: 'Check request', exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('Message', { exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Check request', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(provider.calls.filter(c => c.url.endsWith('/messages/send')).length, 2);
  await root.getByRole('button', { name: 'New email' }).click(); await dialog.getByLabel('Message', { exact: true }).fill('Private unsaved text');
  const other = await page.context().newPage(); await other.goto(origin + '/?account=1'); await other.locator('#nav-inbox').waitFor();
  if (await other.locator('#session-menu-button').isVisible()) await other.locator('#session-menu-button').click(); await other.locator('#signout-button').click();
  await dialog.waitFor({ state: 'hidden' }); assert.equal(await dialog.getByLabel('Message', { exact: true }).inputValue(), '');
  assert.equal(await root.locator('[data-reader]').textContent(), ''); assert.deepEqual(errors, []);
});
