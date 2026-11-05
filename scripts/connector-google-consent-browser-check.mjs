// Reuses the desktop Google fixture transport for existing-agent connector consent.
// Provider authorization/token/JWKS are synthetic; every Room route and cookie is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer as httpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { googleAuth, clientId, sub } from './helpers/google-oauth-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const dynamic of [false, true]) for (const mode of ['normal', 'terms', 'account-retry']) test(`connector ${dynamic ? 'DCR' : 'static'} Google return ${mode} preserves exact consent`, { timeout: 30000 }, async t => {
  const outdatedTerms = mode === 'terms', abortAccountOnce = mode === 'account-retry', returningMember = true, selected = false, providerError = false;
  const f = createAcceptanceFixture();
  if (returningMember || outdatedTerms) f.store.createAccount(`google:${sub}`, 'google');
  if (returningMember) {
    f.store.command(f.keys.owner, 'commons', {id:'returning-google-member',type:'member.added',data:{memberId:'googler',displayName:'Googler',kind:'human',permissions:['steer','accept_work','complete_work','verify']}});
    f.store.bindHumanAccount('commons','googler',`google:${sub}`);
  }
  if (outdatedTerms) {
    f.store.db.prepare('UPDATE account_terms SET terms_version=? WHERE account_id=?').run('2026-09-01', `google:${sub}`);
  }
  const owner = f.store.createSession(f.store.issueAccessKey('commons', 'googler'));
  const identity = f.store.identities.create('Existing Google agent');
  const { linkCode } = f.store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' });
  f.store.agentConnections.apply(owner.token, 'commons', { action: 'create', identityId: identity.identityId, identityLinkCode: linkCode, requestId: 'connector-agent', memberId: 'connected-agent', displayName: 'Existing agent', access: 'collaborate', expectedOwnerRevision: 0, expiresAt: f.store.now() + 3600000, keyHash: createHash('sha256').update('synthetic-fixture-key').digest('hex') }, owner.session.sessionBinding);
  const configured = { clientId: 'claude-return-fixture', name: 'Claude return fixture', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] };
  const directory = mkdtempSync(join(tmpdir(), 'connector-google-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let server;
  const proxy = httpsServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, (req, res) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  server = createRoomServer({ origin, store: f.store, googleAuth: googleAuth(), mcpOAuthClients: [configured] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const page = await context.newPage(), errors = [], providerRequests = [];
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
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<a href="${origin}/api/auth/google/callback?state=${url.searchParams.get('state')}&amp;${result}">Continue with fixture account</a>`);
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
  let connectorId = configured.clientId;
  if (dynamic) {
    const registered = await page.context().request.post(origin + '/oauth/register', { data: { client_name: 'Claude DCR fixture', redirect_uris: configured.redirectUris } });
    assert.equal(registered.status(), 201); connectorId = (await registered.json()).client_id;
  }
  const returnTarget = '/oauth/authorize?' + new URLSearchParams({ client_id: connectorId, redirect_uri: configured.redirectUris[0], response_type: 'code', state: nativeState, code_challenge: challenge, code_challenge_method: 'S256', scope: 'rooms:read chat:read', resource: origin + '/mcp' });
  const consentUrl = new URL(returnTarget, origin);
  // The first callback commits the same-origin bridge; await actual completion.
  const callback = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/auth/google/callback' && url.searchParams.has('room_oauth_resume');
  });
  await page.goto(origin + '/?' + new URLSearchParams({ oauth: 'login', return: returnTarget, provider: 'google' }));
  assert.equal(providerRequests.length, 0, 'generic connector cannot auto-start a selected provider');
  if (!selected) {
    await page.locator('#auth-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#auth-title').innerText(), 'PROJECT ROOM');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.locator('#google-signin').click();
  }
  await page.getByRole('link', { name: 'Continue with fixture account' }).waitFor();
  const roomReads = [];
  page.on('request', req => { const path = new URL(req.url()).pathname;
    if (path === '/api/session' || path.startsWith('/api/rooms/')) roomReads.push(path);
  });
  let abortedAccount;
  if (abortAccountOnce) {
    abortedAccount = page.waitForEvent('requestfailed', req => new URL(req.url()).pathname === '/api/account-session');
    await page.route(origin + '/api/account-session', route => route.abort('failed'), {times:1});
  }
  await page.getByRole('link', { name: 'Continue with fixture account' }).click();
  const firstCallback = await callback;
  assert.equal(firstCallback.status(), 200);
  if (providerError) assert.ok(firstCallback.headers()['x-room-auth-failure']);
  assert.equal(providerRequests.length, 1);
  if (abortAccountOnce) {
    await abortedAccount;
    await page.waitForFunction(() => document.querySelector('#auth-panel')?.hidden === false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), returnTarget);
    assert.deepEqual(roomReads, [], 'failed account confirmation must not start Room restoration');
    await page.reload();
  }
  const session = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(session.authenticated, true); assert.equal(session.account.id, `google:${sub}`);
  assert.equal(session.terms.required, outdatedTerms, 'existing outdated terms require acceptance; fresh signup records the displayed terms');
  if (outdatedTerms) {
    const terms = page.locator('#auth-signin-ui [data-signin-form="terms"]');
    try { await terms.waitFor({ state: 'visible', timeout: 3000 }); }
    catch (error) {
      mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/connector-google-terms-stalled.png', fullPage: true });
      console.error('Connector Google return diagnostic', JSON.stringify({ url: page.url(), authenticated: session.authenticated, termsRequired: session.terms.required, returnRetained: await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')) === returnTarget, visibleAuth: await page.locator('#auth-panel').innerText() }));
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
  assert.equal(page.url(), consentUrl.href, 'terms acceptance resumes the original connector consent byte-for-byte');
  if (returningMember) assert.deepEqual(roomReads, [], 'connector continuation must precede ordinary Room restoration');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('project-room:oauth-return:v1')), null);
  await page.getByRole('button', { name: 'Allow', exact: true }).waitFor();
  assert.equal(await page.locator('select[name=agent_binding] option').count(), 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM oauth_provider_codes').get().n, 0, 'return never auto-approves consent');
  assert.deepEqual(errors, []);
});
