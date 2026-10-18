// Unlike a redirect-only provider stub, this commits a cross-site document.
// Chromium then withholds Strict cookies on the provider's return navigation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { googleAuth, sub } from './helpers/google-oauth-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const mode of ['success', 'wrong-browser', 'no-cookie']) test(`Google cross-site return: ${mode} preserves Strict cookie session binding`, { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, googleAuth: googleAuth() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = createServer((req, res) => {
    const state = new URL(req.url, 'http://localhost').searchParams.get('state');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<a href="${origin}/api/auth/google/callback?state=${encodeURIComponent(state)}&amp;code=fixture">Continue to Room</a>`);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => provider.close(r))]);
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.route(`${origin}/api/auth/google/start`, async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    const authorization = new URL(response.headers().location);
    await route.fulfill({ response, headers: { ...response.headers(), location: `http://localhost:${provider.address().port}/?state=${authorization.searchParams.get('state')}` } });
  });
  await page.goto(`${origin}/api/auth/google/start`);
  if (mode !== 'success') {
    await page.context().clearCookies();
    if (mode === 'wrong-browser') {
      const other = await browser.newContext();
      await other.request.get(`${origin}/api/auth/google/start`, { maxRedirects: 0 });
      await page.context().addCookies(await other.cookies(origin));
      await other.close();
    }
  }
  const callback = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/google/callback');
  await page.getByRole('link', { name: 'Continue to Room' }).click();
  const first = await callback;
  assert.equal((await first.request().allHeaders()).cookie?.includes('account_session=') ?? false, false, 'real cross-site callback omits the Strict cookie');
  await page.waitForURL(url => url.pathname === '/');
  const session = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(session.authenticated, mode === 'success', 'only the original browser can complete sign-in');
  if (mode !== 'success') {
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id LIKE 'google:%'").get().n, 0);
    return;
  }
  assert.equal(session.account.id, `google:${sub}`);
  const cookies = await page.context().cookies(origin);
  assert.equal(cookies.find(c => c.name === 'account_session')?.sameSite, 'Strict');
});
