import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

const githubAuth = { clientId: 'fixture-github-client', clientSecret: 'fixture-github-secret', fetchImpl: async url => {
  if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'fixture-token', token_type: 'bearer', scope: 'read:user user:email' });
  if (url === 'https://api.github.com/user') return Response.json({ id: 424242, login: 'fixture-user' });
  if (url === 'https://api.github.com/user/emails') return Response.json([{ email: 'fixture@example.com', primary: true, verified: true }]);
  throw new Error('Unexpected provider request');
} };
async function setup(t, configured = true) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, githubAuth: configured ? githubAuth : null });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return { f, origin, browser };
}
test('GitHub stays hidden for unavailable, malformed and failed provider capability reads', async t => {
  const { origin, browser } = await setup(t, false);
  for (const mode of ['unconfigured', 'malformed', 'failure']) {
    const page = await browser.newPage();
    if (mode !== 'unconfigured') await page.route('**/api/auth/providers', route => mode === 'failure' ? route.abort() : route.fulfill({ json: { providers: { github: { configured: 'true' } } } }));
    await page.goto(origin); await page.locator('#google-signin').waitFor();
    assert.equal(await page.locator('#github-signin').isVisible(), false);
    assert.equal(await page.locator('#github-signin').count(), 1);
    await page.close();
  }
});
test('configured GitHub is minimal and follows auth view visibility', async t => {
  const { origin, browser } = await setup(t);
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(origin); const github = page.locator('#github-signin'); await github.waitFor();
    assert.equal(await github.textContent(), 'Continue with GitHub');
    await page.screenshot({ path: `/tmp/project-room-github-signin-${width}.png` });
    const googleBox = await page.locator('#google-signin').boundingBox(), githubBox = await github.boundingBox();
    assert.equal(Math.round(githubBox.width), Math.round(googleBox.width)); assert.ok(githubBox.height >= 44);
    // Existing view transitions control provider visibility; the module adds no new view.
    await page.locator('#google-signin').evaluate(node => { node.hidden = true; });
    await github.waitFor({ state: 'hidden' });
    await page.locator('#google-signin').evaluate(node => { node.hidden = false; });
    await github.waitFor();
    const started = page.waitForRequest('**/api/auth/github/start');
    await page.route('**/api/auth/github/start', route => route.fulfill({ status: 200, contentType: 'text/html', body: 'Provider start reached' }));
    await github.click(); await started;
    assert.ok((await page.context().cookies()).some(cookie => cookie.name.includes('account')));
    await page.close();
  }
});
test('GitHub OAuth preserves a share invitation through callback', { timeout: 30000 }, async t => {
  const { f, origin, browser } = await setup(t);
  const token = randomBytes(32).toString('base64url');
  f.store.shareLinks.create(f.keys.owner, 'commons', { requestId: 'github-share', linkToken: token, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0 });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', e => console.error('fixture page error', e.message));
  await page.route(`${origin}/api/auth/github/start`, async route => {
    const response = await route.fetch({ maxRedirects: 0, headers: { ...route.request().headers(), 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' } }); assert.equal(response.status(), 302, await response.text());
    const state = new URL(response.headers().location).searchParams.get('state');
    await route.fulfill({ response, headers: { ...response.headers(), location: `${origin}/api/auth/github/callback?state=${state}&code=fixture-code` } });
  });
  await page.goto(`${origin}/#join/${token}`);
  await page.locator('#join-link-form').waitFor();
  if (await page.locator('#join-account-signin').isVisible()) await page.locator('#join-account-signin').click();
  const callback = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/github/callback');
  await page.locator('#join-account-github').click();
  assert.equal((await callback).status(), 200);
  await page.locator('#join-link-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pr-pending-join')), null);
  assert.equal((await page.request.get(`${origin}/api/account-session`)).status(), 200);
});

test('session preparation failure keeps GitHub retryable without navigating or stashing', async t => {
  const { origin, browser } = await setup(t);
  const page = await browser.newPage(); await page.goto(origin); await page.locator('#github-signin').waitFor();
  await page.evaluate(async () => {
    for (const id of ['github-signin', 'invitation-github', 'join-account-github']) document.getElementById(id)?.remove();
    const { installGitHubSignin } = await import('/src/oauth-signin-ui.js');
    window.githubTest = { navigations: 0, stashes: 0, attempts: 0 };
    installGitHubSignin({ accountClient: { request: async () => ({ providers: { github: { configured: true } } }) },
      ensureAccountSession: async () => { window.githubTest.attempts++; throw new Error('offline'); },
      stashInviteForOAuth: () => { window.githubTest.stashes++; }, navigate: () => { window.githubTest.navigations++; } });
  });
  await page.locator('#github-signin').click();
  await page.getByText('Could not start GitHub sign-in. Try again.', { exact: true }).waitFor();
  assert.equal(await page.locator('#github-signin').getAttribute('aria-disabled'), null);
  await page.locator('#github-signin').click();
  assert.deepEqual(await page.evaluate(() => window.githubTest), { navigations: 0, stashes: 0, attempts: 2 });
});
