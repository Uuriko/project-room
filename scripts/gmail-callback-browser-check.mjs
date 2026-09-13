import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

test('browser callback cleans history and completes with strict-cookie session', async t => {
  const f = createAcceptanceFixture(); const calls = [];
  const account = f.store.accountForMember('commons', 'owner'); const slot = f.store.createAccountSessionSlot();
  f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const server = createRoomServer({ store: f.store, gmailConnections: { complete(session, callbackUrl) {
    calls.push({ session, callbackUrl }); return { state: 'connected' };
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); const origin = `http://127.0.0.1:${server.address().port}`;
  await context.addCookies([{ name: 'account_session', value: slot.token, url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/api/inbox/connections/gmail/callback?code=fixture-secret-code&state=fixture-state');
  await page.waitForFunction(() => document.querySelector('#gmail-status')?.textContent.includes('Gmail connected.'));
  assert.equal(await page.getByRole('link', { name: 'Back to Inbox' }).getAttribute('href'), '/?account=1#pr-view/inbox');
  assert.equal(calls.length, 1); assert.equal(calls[0].session.token, slot.token);
  assert.ok(calls[0].callbackUrl.includes('fixture-secret-code'));
  assert.equal(new URL(page.url()).search, '');
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-secret-code'));
  assert.deepEqual(errors, []);
});
