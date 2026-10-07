// Owns real desktop consent through Google's cross-origin browser return.
// Provider authorization/token/JWKS are synthetic; every Room route and cookie is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium, request } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { googleAuth, clientId, sub } from './helpers/google-oauth-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const { outdatedTerms, selected, providerError } of [...([false, true].flatMap(outdatedTerms => [false, true].map(selected => ({ outdatedTerms, selected })))), { outdatedTerms: false, selected: true, providerError: 'access_denied' }, { outdatedTerms: false, selected: true, providerError: 'server_error' }]) test(`desktop ${selected ? 'selected' : 'generic'} ${providerError || 'success'} Google ${outdatedTerms ? 'updated terms' : 'new signup'} keeps same-tab native return and exact PKCE consent`, { timeout: 40000 }, async t => {
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
    const result = providerError && providerRequests.length === 1 ? `error=${providerError}` : 'code=synthetic-google-code';
    res.writeHead(302, { Location: `${origin}/api/auth/google/callback?state=${url.searchParams.get('state')}&${result}` }); res.end();
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
  const started = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/desktop/start');
  const callback = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/google/callback');
  await page.goto(`${origin}/api/auth/desktop/start?state=${nativeState}&challenge=${challenge}${selected ? '&provider=google' : ''}`);
  if (!selected) {
    await page.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#auth-title').innerText(), 'PROJECT ROOM');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.locator('#google-signin').click();
  }
  const firstCallback = await callback;
  assert.equal(firstCallback.status(), 200);
  if (providerError) assert.ok(firstCallback.headers()['x-room-auth-failure']);
  assert.equal(providerRequests.length, 1);
  const entrance = new URL((await started).headers().location, origin);
  const returnTarget = selected ? entrance.searchParams.get('return') : entrance.pathname + entrance.search;
  const consentUrl = new URL(returnTarget, origin);
  assert.equal(consentUrl.pathname, '/oauth/authorize');
  assert.equal(consentUrl.searchParams.get('state'), nativeState);
  assert.equal(consentUrl.searchParams.get('code_challenge'), challenge);
  if (providerError) {
    await page.locator('#auth-panel').waitFor({ state: 'visible' });
    await page.locator('#google-signin').waitFor({ state: 'visible' });
    assert.match(await page.locator('#auth-error').innerText(), /Google sign-in didn.t finish/);
    assert.equal(new URL(page.url()).searchParams.has('provider'), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), returnTarget);
    assert.equal((await (await page.context().request.get(`${origin}/api/account-session`)).json()).authenticated, false);
    await page.reload();
    await page.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.equal(providerRequests.length, 1, 'reload after provider error cannot auto-start again');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const retry = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/google/callback');
    await page.locator('#google-signin').click();
    assert.equal((await retry).status(), 200);
    assert.equal(providerRequests.length, 2, 'explicit retry is the only second provider request');
  }
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
  // A provider chosen in the native app must not replace an already signed-in
  // browser account. Its actual profile is escaped and disclosed at consent.
  const accountName = '<img src=x onerror=alert(1)>';
  f.store.updateAccountProfile(`google:${sub}`, { displayName: accountName });
  f.store.accountLogins.linkMagicMethod(`google:${sub}`, { email: 'desktop-verified@example.com' });
  if (outdatedTerms) f.store.db.prepare('UPDATE account_terms SET terms_version=? WHERE account_id=?').run('2026-09-01', `google:${sub}`);
  const providerCount = providerRequests.length;
  const otherProviderRequests = [];
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/auth/github/start') otherProviderRequests.push(req.url()); });
  await page.goto(`${origin}/api/auth/desktop/start?state=${nativeState}&challenge=${challenge}&provider=github`);
  if (outdatedTerms) {
    const terms = page.locator('#auth-signin-ui [data-signin-form="terms"]');
    await terms.waitFor({ state: 'visible' });
    assert.equal((await (await page.context().request.get(`${origin}/api/account-session`)).json()).account.id, `google:${sub}`);
    await terms.getByRole('button', { name: 'Agree and continue', exact: true }).click();
  }
  await page.waitForURL(url => url.pathname === '/oauth/authorize');
  assert.equal(page.url(), consentUrl.href);
  assert.equal(await page.locator('[data-native-account]').innerText(), `Account: ${accountName} · desktop-verified@example.com`);
  assert.equal(await page.locator('[data-native-account] img').count(), 0, 'untrusted profile renders as text');
  assert.equal(providerRequests.length, providerCount);
  assert.deepEqual(otherProviderRequests, [], 'authenticated browser is not silently switched to selected provider');
  assert.deepEqual(errors, []);
});

test('selected GitHub starts after real anonymous session restore and cancellation preserves native retry', { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture();
  const proxy = createServer((req, res) => {
    if (req.url === '/api/auth/github/start') {
      assert.equal(req.headers['sec-fetch-mode'], 'navigate');
      assert.equal(req.headers['sec-fetch-site'], 'same-origin');
    }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers }, reply => {
      const headers = { ...reply.headers };
      if (headers.location?.startsWith('https://github.com/login/oauth/authorize?')) {
        const authorization = new URL(headers.location);
        headers.location = `http://localhost:${provider.address().port}${authorization.pathname}${authorization.search}`;
      }
      res.writeHead(reply.statusCode, headers); reply.pipe(res);
    });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const server = createRoomServer({ origin, store: f.store, githubAuth: { clientId: 'Iv1.fixtureclientid0000', clientSecret: 'dummy-github-fixture-secret', fetchImpl: async () => { throw new Error('denied flow must not exchange a token'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(), errors = [], providerRequests = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const provider = createServer((req, res) => {
    const url = new URL(req.url, 'https://github.com'); providerRequests.push(url);
    assert.equal(url.pathname, '/login/oauth/authorize');
    assert.equal(url.searchParams.get('scope'), 'read:user user:email');
    assert.doesNotMatch(req.headers.cookie || '', /account_session=/);
    res.writeHead(302, { Location: `${origin}/api/auth/github/callback?state=${url.searchParams.get('state')}&error=access_denied` }); res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  // Preserve actual Chromium navigation Fetch Metadata through the Room
  // transport. Map only GitHub's external authority on its real 302 response;
  // Playwright route.fetch would drop those late-generated browser headers.
  const started = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/desktop/start');
  const githubStarted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/github/start');
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/github/callback');
  returned.catch(() => {}); // Keep a failed start diagnostic primary during teardown.
  await page.goto(`${origin}/api/auth/desktop/start?state=${'s'.repeat(43)}&challenge=${'c'.repeat(43)}&provider=github`);
  assert.equal((await githubStarted).status(), 302, 'actual browser navigation begins the provider flow');
  assert.equal((await returned).status(), 200);
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#auth-error').innerText(), /GitHub sign-in didn.t finish/);
  const target = new URL((await started).headers().location, origin).searchParams.get('return');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), target);
  await page.reload(); await page.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(providerRequests.length, 1);
  assert.equal((await (await page.context().request.get(`${origin}/api/account-session`)).json()).authenticated, false);
  assert.deepEqual(errors, []);
});

test('untrusted desktop provider entrance cannot start OAuth or store an external return', { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, googleAuth: googleAuth() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const generic = await fetch(`${origin}/api/auth/desktop/start?state=${'s'.repeat(43)}&challenge=${'c'.repeat(43)}`, { redirect: 'manual' });
  const target = generic.headers.get('location');
  const otherClient = new URL(target, origin); otherClient.searchParams.set('client_id', 'other-client');
  const duplicatedState = new URL(target, origin); duplicatedState.searchParams.append('state', 's'.repeat(43));
  for (const candidate of [
    new URLSearchParams({ oauth: 'login', return: 'https://evil.example/oauth/authorize?x=1', provider: 'google' }),
    new URLSearchParams({ oauth: 'login', return: otherClient.pathname + otherClient.search, provider: 'google' }),
    new URLSearchParams({ oauth: 'login', return: duplicatedState.pathname + duplicatedState.search, provider: 'google' }),
    new URLSearchParams([['oauth', 'login'], ['return', target], ['provider', 'google'], ['provider', 'github']])
  ]) {
    const page = await browser.newPage(), starts = [];
    await page.route(`${origin}/api/auth/google/start`, route => { starts.push(route.request().url()); return route.abort(); });
    await page.goto(`${origin}/?${candidate}`);
    await page.waitForFunction(() => document.querySelector('#identity-label')?.textContent === 'Not signed in');
    assert.deepEqual(starts, [], 'only a single validated native provider intent may auto-start');
    assert.equal(new URL(page.url()).origin, origin);
    if (candidate.get('return').startsWith('https:')) assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), null);
    await page.close();
  }
});
