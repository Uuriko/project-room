// Owns real desktop consent through Google's cross-origin browser return.
// Provider authorization/token/JWKS are synthetic; every Room route and cookie is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium, request } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { googleAuth, clientId, sub } from './helpers/google-oauth-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const outdatedTerms of [false, true]) test(`desktop Google ${outdatedTerms ? 'updated terms' : 'new signup'} keeps same-tab native return and exact PKCE consent`, { timeout: 40000 }, async t => {
  const f = createAcceptanceFixture();
  if (outdatedTerms) {
    f.store.createAccount(`google:${sub}`, 'google');
    f.store.db.prepare('UPDATE account_terms SET terms_version=? WHERE account_id=?').run('2026-09-01', `google:${sub}`);
  }
  const server = createRoomServer({ store: f.store, googleAuth: googleAuth() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(), errors = [], providerRequests = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const verifier = 'v'.repeat(43), nativeState = 's'.repeat(43), challenge = createHash('sha256').update(verifier).digest('base64url');
  const provider = createServer((req, res) => {
    const url = new URL(req.url, 'https://accounts.google.com'); providerRequests.push(url);
    assert.equal(req.method, 'GET'); assert.equal(url.pathname, '/o/oauth2/v2/auth');
    assert.doesNotMatch(req.headers.cookie || '', /account_session=/, 'Room cookie never reaches the provider');
    assert.equal(url.searchParams.get('client_id'), clientId);
    assert.equal(url.searchParams.get('redirect_uri'), `${origin}/api/auth/google/callback`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
    res.writeHead(302, { Location: `${origin}/api/auth/google/callback?state=${url.searchParams.get('state')}&code=synthetic-google-code` }); res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerOrigin = `http://localhost:${provider.address().port}`;
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  // Playwright cannot intercept a redirect's second leg. Fetch the actual
  // Room start response without following it and map only Google's authority
  // to the bounded provider. Room status, cookie, PKCE/state/query stay real.
  await page.route(`${origin}/api/auth/google/start`, async route => {
    const response = await route.fetch({ maxRedirects: 0 }); assert.equal(response.status(), 302);
    const authorize = new URL(response.headers().location); assert.equal(authorize.origin, 'https://accounts.google.com');
    await route.fulfill({ response, headers: { ...response.headers(), location: providerOrigin + authorize.pathname + authorize.search } });
  });
  await page.goto(`${origin}/api/auth/desktop/start?state=${nativeState}&challenge=${challenge}`);
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#auth-title').innerText(), 'PROJECT ROOM');
  const returnTarget = await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1'));
  const consentUrl = new URL(returnTarget, origin);
  assert.equal(consentUrl.pathname, '/oauth/authorize');
  assert.equal(consentUrl.searchParams.get('state'), nativeState);
  assert.equal(consentUrl.searchParams.get('code_challenge'), challenge);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  const callback = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/google/callback');
  await page.locator('#google-signin').click();
  assert.equal((await callback).status(), 200);
  assert.equal(providerRequests.length, 1);
  const session = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(session.authenticated, true); assert.equal(session.account.id, `google:${sub}`);
  assert.equal(session.terms.required, outdatedTerms, 'existing outdated terms require acceptance; fresh signup records the displayed terms');
  if (outdatedTerms) {
    const terms = page.locator('#auth-signin-ui [data-signin-form="terms"]');
    try { await terms.waitFor({ state: 'visible', timeout: 3000 }); }
    catch (error) {
      mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/desktop-google-terms-stalled.png', fullPage: true });
      console.error('Google return diagnostic', JSON.stringify({ url: page.url(), authenticated: session.authenticated, termsRequired: session.terms.required, returnRetained: await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')) === returnTarget, visibleAuth: await page.locator('#auth-panel').innerText() }));
      throw error;
    }
    assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), returnTarget);
    // A policy update between page load and submission must reject the stale
    // version at the real server, keep terms visible, and retain native return.
    await page.route(`${origin}/api/account/terms`, async route => {
      const input = route.request().postDataJSON(); assert.equal(input.version, session.terms.version);
      await route.continue({ postData: JSON.stringify({ ...input, version: '2026-09-01' }) });
    }, { times: 1 });
    const refused = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/account/terms');
    await terms.getByRole('button', { name: 'Agree and continue', exact: true }).click();
    assert.equal((await refused).status(), 409);
    await page.locator('[data-signin-status]').filter({ hasText: /terms changed/i }).waitFor();
    assert.equal(await terms.isVisible(), true);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), returnTarget);
    assert.equal((await (await page.context().request.get(`${origin}/api/account-session`)).json()).terms.required, true);
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/account/terms');
    await terms.getByRole('button', { name: 'Agree and continue', exact: true }).click();
    assert.equal((await accepted).status(), 200);
  }
  await page.waitForURL(url => url.pathname === '/oauth/authorize');
  assert.equal(page.url(), consentUrl.href, 'terms acceptance resumes the original native consent byte-for-byte');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), null);
  assert.match(await page.locator('h1').innerText(), /Project Room for Mac/);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/desktop-google-${outdatedTerms ? 'updated-terms' : 'signup'}-consent.png`, fullPage: true });
  const allow = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/oauth/authorize');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  const decision = await allow; assert.equal(decision.status(), 302);
  const desktopCallback = new URL(decision.headers().location, origin);
  assert.equal(desktopCallback.pathname, '/api/auth/desktop/callback'); assert.equal(desktopCallback.searchParams.get('state'), nativeState);
  const nativeRedirect = await page.context().request.get(desktopCallback.href, { maxRedirects: 0 });
  assert.equal(nativeRedirect.status(), 302);
  const app = new URL(nativeRedirect.headers().location); assert.equal(app.protocol, 'projectroom:'); assert.equal(app.searchParams.get('state'), nativeState);
  const nativeClient = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  t.after(() => nativeClient.dispose());
  const native = await nativeClient.post('/api/auth/desktop/session', { data: { code: app.searchParams.get('code'), verifier } });
  assert.equal(native.status(), 201);
  const nativeSession = await (await nativeClient.get('/api/account-session')).json();
  assert.equal(nativeSession.authenticated, true, 'successful exchange installs a usable native account cookie');
  assert.equal(nativeSession.account.id, `google:${sub}`);
  assert.equal(nativeSession.terms.required, false);
  const replay = await page.context().request.post(`${origin}/api/auth/desktop/session`, { headers: { Origin: origin, Cookie: '' }, data: { code: app.searchParams.get('code'), verifier } });
  assert.equal(replay.status(), 401, 'the native code is single-use');
  assert.deepEqual(errors, []);
});
