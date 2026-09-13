import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const width of [390, 1280]) test(`Provider Join ${width}: verified Welcome admission and sign-out`, async t => {
  const f = createAcceptanceFixture(), issuer = 'https://clerk.example.com';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const server = createRoomServer({ store: f.store, streamInterval: 50, providerAuth: { issuer,
    publishableKey: 'pk_test_' + Buffer.from('clerk.example.com$').toString('base64'),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), authorizedParties: ['http://localhost:3000'] } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(10000);
  const now = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'RS256', typ: 'JWT' }, { iss: issuer, azp: 'http://localhost:3000', sub: 'user_browser', sid: 'sess_browser',
    iat: now, nbf: now, exp: now + 300 }].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const token = input + '.' + sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
  // Only the SDK interaction is synthetic. Admission, cookies, CSRF, signatures,
  // ownership and the rendered application use the real server and client.
  await page.route(issuer + '/npm/**', route => route.fulfill({ contentType: 'text/javascript', body:
    route.request().url().includes('/ui@') ? 'window.__internal_ClerkUICtor = {};' : `
      let listener = () => {};
      window.Clerk = { session: null, load: async () => {}, addListener(fn) { listener = fn; },
        openSignIn() { this.session = { getToken: async () => ${JSON.stringify(token)} }; listener(); },
        closeSignIn() {}, async signOut() { this.session = null; listener(); } };
    ` }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.clock.install();
  await page.locator('#provider-join-button').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#key-access').evaluate(el => el.open), false);
  await page.locator('#provider-join-button').click();
  await page.locator('#room-title').filter({ hasText: 'Welcome' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('room'), 'welcome');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  const members = Object.values(f.store.room('welcome').state.members);
  assert.equal(members.length, 2);
  assert.deepEqual(members.find(member => member.id !== 'welcome-host').permissions, []);
  await page.locator('#message-input').fill('Keep this draft');
  const renewal = page.waitForResponse(response => response.url().endsWith('/api/provider-session/refresh'));
  await page.clock.fastForward(21000);
  assert.equal((await renewal).status(), 200);
  assert.equal(await page.locator('#message-input').inputValue(), 'Keep this draft');
  await page.locator('#message-input').fill('');
  await page.locator('#signout-button').click();
  await page.locator('#provider-join-button').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.Clerk.session), null);
});
