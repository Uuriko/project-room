// Real HTTPS browser forms exercise cookie prefixes, SameSite, Origin and CSP.
// Local registered client only; this does not prove a native platform install.
// Back below is review -> entry. Callback -> POST review currently produces
// Chromium ERR_CACHE_MISS (no-store); that separate PRG improvement is not proven.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { defaultServerArgs } from '../server/boot-options.mjs';

test('native invitation HTTPS browser: review Back, lost-response retry and revocation without an account', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-native-browser-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let backend;
  const submitted = [], callbackReferrers = [];
  const proxy = createServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, (req, res) => {
    if (req.url.startsWith('/native-test-callback')) { callbackReferrers.push(req.headers.referer); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Native client received consent</h1>'); return; }
    if (req.url === '/oauth/invite') submitted.push({ origin: req.headers.origin, cookie: Boolean(req.headers.cookie) });
    const upstream = request({ hostname: '127.0.0.1', port: backend.address().port, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const origin = `https://127.0.0.1:${proxy.address().port}`, resource = origin + '/mcp';
  const client = { clientId: 'browser-native-test', name: 'Disposable native test', redirectUris: [origin + '/native-test-callback'] };
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  t.after(() => store.close());
  const owner = store.issueAccessKey('commons', 'owner');
  const invitation = store.invites.create(owner, 'commons', { profile: 'member' });
  const accounts = store.db.prepare('SELECT count(*) n FROM accounts').get().n;
  backend = createRoomServer(defaultServerArgs({ store, origin, env: { ROOM_MCP_OAUTH_CLIENTS: JSON.stringify([client]) } }));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(async () => { backend.closeStreams(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const verifier = 'b'.repeat(43);
  const start = origin + '/oauth/authorize?' + new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'rooms:read chat:read chat:write', state: 'browser-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
  const initial = await page.goto(start);
  assert.equal(initial.headers()['referrer-policy'], 'same-origin');
  const nonce = await page.locator('input[name="nonce"]').inputValue();
  const consentCookie = (await context.cookies()).find(cookie => cookie.name === `__Host-oauth_invite_${nonce.slice(0, 16)}`);
  assert.equal(consentCookie?.value, nonce, 'real browser persisted the exact form nonce in its scoped cookie');
  await page.getByLabel('Agent invitation link or RM code').fill(`${origin}/#agent-invite/${invitation.code}`);
  await page.getByRole('button', { name: 'Review invitation' }).click();
  await page.getByRole('button', { name: 'Connect this agent' }).waitFor().catch(async error => { throw new Error(JSON.stringify({ body: await page.locator('body').innerText(), submitted, cookies: (await context.cookies()).map(({ name, secure, sameSite }) => ({ name, secure, sameSite })) }), { cause: error }); });
  assert.match(await page.locator('main').innerText(), /Invitation sponsor/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM oauth_invite_grants').get().n, 0);
  await page.goBack();
  await page.getByLabel('Agent invitation link or RM code').fill(invitation.code);
  await page.getByRole('button', { name: 'Review invitation' }).click();
  await page.getByLabel('Agent name').fill('Browser friend agent');
  // Simulate losing the redirect response after the server commits consent.
  // Keep the review form visible so the user can retry via an actual form POST.
  const reviewHtml = await page.content();
  let firstCallback;
  await page.route(origin + '/oauth/invite', async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    assert.equal(response.status(), 302);
    assert.equal(response.headers()['referrer-policy'], 'no-referrer');
    firstCallback = response.headers().location;
    await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'Referrer-Policy': 'same-origin' }, body: reviewHtml });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Connect this agent' }).click();
  await page.getByRole('button', { name: 'Connect this agent' }).waitFor();
  await page.getByLabel('Agent name').fill('Browser friend agent');
  await page.getByRole('button', { name: 'Connect this agent' }).click();
  await page.getByRole('heading', { name: 'Native client received consent' }).waitFor();
  const callback = page.url(), code = new URL(callback).searchParams.get('code');
  assert.match(code, /^iac_/); assert.equal(new URL(callback).searchParams.get('state'), 'browser-state');
  assert.equal(callback, firstCallback, 'retry returns the same unconsumed code');
  assert.deepEqual(callbackReferrers, [undefined], 'outbound redirect suppresses the consent page referrer');
  assert.equal(store.db.prepare('SELECT count(*) n FROM agent_invite_redeem_receipts').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM accounts').get().n, accounts);
  const cookies = await context.cookies();
  assert.ok(cookies.some(cookie => cookie.name.startsWith('__Host-oauth_invite_') && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax'));
  assert.ok(cookies.every(cookie => cookie.name.startsWith('__Host-oauth_invite_')), 'no Room or account session established');
  assert.ok(submitted.length >= 4 && submitted.every(value => value.origin === origin && value.cookie), 'browser supplies actual matching Origin and cookie');
  const tokensResponse = await context.request.post(origin + '/oauth/token', { form: { grant_type: 'authorization_code', client_id: client.clientId, redirect_uri: client.redirectUris[0], code_verifier: verifier, resource, code } });
  assert.equal(tokensResponse.status(), 200);
  const tokens = await tokensResponse.json();
  const access = () => context.request.post(resource, { headers: { Authorization: `Bearer ${tokens.access_token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'room_check_access', arguments: {} } } });
  assert.equal((await access()).status(), 200);
  store.db.prepare('UPDATE agent_invite_codes SET revoked_at=?').run(Date.now());
  assert.equal((await access()).status(), 401);
  const refreshed = await context.request.post(origin + '/oauth/token', { form: { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: tokens.refresh_token, resource } });
  assert.equal(refreshed.status(), 400);
  // A fresh authorization cannot silently reuse the revoked/consumed invitation.
  await page.goto(start);
  await page.getByLabel('Agent invitation link or RM code').fill(invitation.code);
  const denied = page.waitForResponse(response => response.url() === origin + '/oauth/invite');
  await page.getByRole('button', { name: 'Review invitation' }).click();
  assert.equal((await denied).status(), 400);
  assert.equal(store.db.prepare('SELECT count(*) n FROM oauth_invite_grants').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM accounts').get().n, accounts);
});
