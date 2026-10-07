// Real loopback WKWebView + Room Google/PKCE/cookie boundary. Only external provider/session UI is synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { googleAuth, clientId } from '../../scripts/helpers/google-oauth-fixture.mjs';
import { createAcceptanceFixture } from '../../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../../server/http.mjs';
if (process.platform !== 'darwin') throw new Error('Native WKWebView acceptance requires macOS');
const fixture = createAcceptanceFixture(), server = createRoomServer({ store: fixture.store, googleAuth: googleAuth() });
const handler = server.listeners('request')[0];
let origin, browser, provider, snapshots = 0, embeddedGoogleRequests = 0, desktopRedemptions = 0;
async function completeBrowser(start) {
  const target = new URL(start); assert.equal(target.origin, origin); assert.equal(target.pathname, '/api/auth/desktop/start');
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  try {
    await page.route(`${origin}/api/auth/google/start`, async route => {
      const response = await route.fetch({ maxRedirects: 0 }); assert.equal(response.status(), 302);
      const authorize = new URL(response.headers().location); assert.equal(authorize.origin, 'https://accounts.google.com');
      await route.fulfill({ response, headers: { ...response.headers(), location: `http://localhost:${provider.address().port}${authorize.pathname}${authorize.search}` } });
    });
    // Keep OS custom-scheme handling isolated; obtain its real Location via the API client below.
    await page.route(`${origin}/api/auth/desktop/callback?**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: 'Native callback captured' }));
    await page.goto(target.href);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.locator('#google-signin').click();
    await page.waitForURL(url => url.pathname === '/oauth/authorize');
    assert.equal(new URL(page.url()).searchParams.get('state'), target.searchParams.get('state'));
    const allowed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/oauth/authorize');
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    const decision = await allowed; assert.equal(decision.status(), 302);
    const callback = new URL(decision.headers().location, origin);
    const redirect = await page.context().request.get(callback.href, { maxRedirects: 0 }); assert.equal(redirect.status(), 302);
    const native = new URL(redirect.headers().location); assert.equal(native.protocol, 'projectroom:');
    assert.equal(native.searchParams.get('state'), target.searchParams.get('state'));
    return native.href;
  } finally { await page.close(); }
}
server.removeAllListeners('request');
server.on('request', async (req, res) => {
  if (req.url?.startsWith('/__native_acceptance__/browser-complete?')) {
    try { const callback = await completeBrowser(new URL(req.url, origin).searchParams.get('start')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ callback })); }
    catch (error) { console.error(error); res.writeHead(500); res.end('Browser completion failed'); }
    return;
  }
  if (req.url === '/api/account-session' && req.method === 'GET') { snapshots++; await new Promise(resolve => setTimeout(resolve, 150)); }
  if (req.url?.startsWith('/api/auth/google/start') && req.headers['user-agent']?.includes('ProjectRoomMac')) embeddedGoogleRequests++;
  if (req.url === '/api/auth/desktop/session') desktopRedemptions++;
  await handler(req, res);
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  provider = createServer((req, res) => {
    const url = new URL(req.url, 'https://accounts.google.com');
    assert.equal(url.pathname, '/o/oauth2/v2/auth'); assert.equal(url.searchParams.get('client_id'), clientId);
    assert.equal(url.searchParams.get('redirect_uri'), `${origin}/api/auth/google/callback`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.doesNotMatch(req.headers.cookie || '', /account_session=/);
    res.writeHead(302, { Location: `${origin}/api/auth/google/callback?state=${url.searchParams.get('state')}&code=synthetic-google-code` }); res.end();
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve)); browser = await chromium.launch({ headless: true });
  const child = spawn(fileURLToPath(new URL('.build/release/NativeAuthAcceptance', import.meta.url)), [origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  let status; try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); } finally { clearTimeout(timer); }
  console.log(JSON.stringify({ nativeStatus: status, actualAccountSnapshots: snapshots, embeddedGoogleRequests, desktopRedemptions }));
  assert.deepEqual(status, { code: 0, signal: null }); assert.ok(snapshots > 0); assert.equal(embeddedGoogleRequests, 0);
  assert.equal(desktopRedemptions, 1, 'only successful current attempt redeems the real code');
} finally {
  await browser?.close(); if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
}
