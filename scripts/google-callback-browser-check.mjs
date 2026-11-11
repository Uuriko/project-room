import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import * as T from '../src/events.js';
import { googleAuth, sub } from './helpers/google-oauth-fixture.mjs';

for (const link of [false, true]) test(`Google ${link ? 'link' : 'sign-in'} returns from a committed cross-site account chooser with Strict cookies`, { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), auth = googleAuth();
  let providerCalls = 0;
  const exchange = auth.fetchImpl;
  auth.fetchImpl = (...args) => { providerCalls++; return exchange(...args); };
  const server = createRoomServer({ store: f.store, googleAuth: auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.ROOM_TEST_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true }), page = await browser.newPage();
  let callbackUrl;
  const provider = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    callbackUrl = `${origin}/api/auth/google/callback?state=${url.searchParams.get('state')}&code=fixture-code`;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<a id="choose" href="${callbackUrl.replaceAll('&', '&amp;')}">Choose account</a>`);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser.close();
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close();
  });
  let expectedAccount = `google:${sub}`;
  if (link) {
    expectedAccount = 'existing-link-account'; f.store.createAccount(expectedAccount, 'fixture');
    const slot = f.store.createAccountSessionSlot();
    f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(expectedAccount), slot.session.sessionRevision);
    await page.context().addCookies([{name:'account_session',value:slot.token,url:origin,httpOnly:true,sameSite:'Strict'}]);
  }
  if (!link) {
    const slot = f.store.createAccountSessionSlot();
    f.store.loginAccountSessionWithGoogle(slot.token, sub, 0);
    f.store.command(f.keys.owner, 'commons', { id: 'google-browser-member', type: T.EVENT_TYPES.MEMBER_ADDED,
      data: { memberId: 'googler', displayName: 'Googler', kind: 'human', permissions: [] } });
    f.store.bindHumanAccount('commons', 'googler', expectedAccount);
  }
  const startPath = `/api/auth/google/${link ? 'link/' : ''}start`;
  await page.route(origin + startPath, async route => {
    const response = await route.fetch({maxRedirects:0}), url = new URL(response.headers().location);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(response.status(), 302);
    const target = `http://localhost:${provider.address().port}${url.pathname}${url.search}`;
    // WebKit cannot fulfill an intercepted302. Only substitute the provider
    // destination; retain the actual Room response cookies, state and PKCE.
    await route.fulfill({response,status:200,headers:{...response.headers(),'content-type':'text/html',location:''},
      body:`<meta http-equiv="refresh" content="0;url=${target.replaceAll('&','&amp;')}">`});
  });
  // Establish the Room site first, as the real sign-in/settings UI does.
  await page.goto(origin + (link ? '/' : '/?room=commons'));
  if (link) await page.goto(origin + startPath);
  else await page.locator('#google-signin').click();
  await page.waitForURL(url => url.hostname === 'localhost');
  assert.equal((await page.context().cookies(origin)).find(c=>c.name==='account_session').sameSite, 'Strict');
  assert.equal(providerCalls, 0);
  await page.click('#choose');
  await page.waitForURL(url => url.origin === origin && url.pathname === '/' && (url.searchParams.has('account') || url.searchParams.has('google')));
  const session = await (await page.context().request.get(origin + '/api/account-session')).json();
  assert.equal(session.authenticated, true, `cross-site callback failed: ${new URL(page.url()).search}`);
  assert.equal(session.account.id, expectedAccount);
  assert.equal(providerCalls, 2);
  assert.equal((await page.context().cookies(origin)).find(c=>c.name==='account_session').sameSite, 'Strict');
  if (!link) {
    await page.locator('#main').waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).searchParams.get('room'), 'commons');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:google-room-return:v1')), null);
  }
  const replay = await page.context().request.get(callbackUrl);
  assert.equal(replay.headers()['x-room-auth-failure'], 'google_state_invalid');
  assert.equal(providerCalls, 2, 'replay never exchanges a second code');
});
