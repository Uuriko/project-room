import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createServer as createPortProbe } from "node:net";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixtureInPlace } from "./in-place-fixture-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { axeSerious, assertAxeClean, chromiumLaunchOptions } from "./a11y-axe-helper.mjs";

async function setup(t, { passkey = false } = {}) {
  const f = createAcceptanceFixture();
  let port = 0, configuredOrigin;
  if (passkey) {
    const probe = createPortProbe(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    configuredOrigin = `http://localhost:${port}`;
  }
  const server = createRoomServer({ store: f.store, origin: configuredOrigin });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  const origin = configuredOrigin ?? `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  await page.goto(origin + "/?room=commons");
  await page.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
  return { ...f, page, origin };
}

test("compact login and signup remain usable in both themes and small windows", { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  mkdirSync("test-results/login-polish", { recursive: true });
  for (const theme of ["dark", "light"]) for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const form = page.locator('[data-signin-form="password"]');
    assert.equal(await page.locator('[data-signin-back]').count(), 0, "no entrance or Back step");
    assert.equal(await page.locator('.signin-more').count(), 0, "no one-item menu");
    assert.equal(await page.locator('.signin-logo').evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await form.locator('[name="email"]').getAttribute("autocomplete"), "username");
    assert.equal(await form.locator('[name="password"]').getAttribute("autocomplete"), "current-password");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const selector of ['[data-signin-form="password"] button[type="submit"]', '[data-password-visibility]', '[data-password-mode]', '[data-forgot-password]', '[data-passkey-signin]', '#agent-signin-button']) {
      const box = await page.locator('#auth-panel').locator(selector).boundingBox();
      assert.ok(box.height >= 44, selector + " touch target");
    }
    await form.locator('[name="email"]').fill('layout@example.invalid');
    await form.locator('[name="password"]').fill('synthetic-password');
    await form.locator('[data-password-visibility]').click();
    assert.equal(await form.locator('[name="password"]').getAttribute("type"), "text");
    assert.equal(await form.locator('[name="password"]').inputValue(), "synthetic-password");
    assert.equal(await form.locator('[data-password-visibility]').getAttribute("aria-label"), "Hide password");
    await form.locator('[data-password-visibility]').click();
    await form.locator('[data-password-mode="signup"]').click();
    assert.equal(await form.locator('[name="email"]').inputValue(), 'layout@example.invalid');
    assert.equal(await form.locator('[name="password"]').getAttribute("autocomplete"), "new-password");
    assert.equal(await form.locator('[data-forgot-password]').count(), 0);
    assert.equal(await form.locator('[data-email-method]').count(), 0);
    assert.equal(await form.locator('[data-passkey-signin]').count(), 0);
    assertAxeClean(await axeSerious(page), `signup ${theme} ${viewport.width}x${viewport.height}`);
    await form.locator('[data-password-mode="login"]').click();
    assertAxeClean(await axeSerious(page), `login ${theme} ${viewport.width}x${viewport.height}`);
    await page.screenshot({ path: `test-results/login-polish/${theme}-${viewport.width}x${viewport.height}.png`, fullPage: true });
  }
  await page.locator('#agent-signin-button').click();
  await page.locator('#agent-auth-step').waitFor({ state: 'visible' });
  await page.locator('#agent-auth-back').click();
  await page.locator('[data-signin-form="password"]').waitFor({ state: 'visible' });
  await page.locator('[name="email"]').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('[name="password"]').evaluate(el => el === document.activeElement), true);
});

test("a real virtual-authenticator passkey can be enrolled, used after logout, and replay is refused", { timeout: 45000 }, async t => {
  const { page, store, keys, origin } = await setup(t, { passkey: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true
  } });
  await signInFixtureInPlace(page, store, keys.owner);
  const before = await (await page.context().request.get(origin + '/api/account-session')).json();
  await clickChrome(page, '#account-settings-button');
  const registration = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/passkey/register/finish');
  await page.locator('[data-action="passkey-add"]').click();
  const registered = await registration.catch(async error => { throw new Error(`${error.message}: ${await page.locator('[data-settings-status]').textContent()}`); });
  assert.equal(registered.status(), 201, 'real browser attestation verified and stored');
  const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.credentials.length, 1);
  assert.equal(credentials.credentials[0].isResidentCredential, true, 'account can be discovered without typing its email');
  await page.keyboard.press('Escape');
  await clickChrome(page, '#signout-button');
  await page.goto(origin + '/?room=commons');
  await page.locator('[data-signin-form="password"]').waitFor({ state: 'visible' });
  const assertion = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/passkey/authenticate/finish');
  await page.locator('[data-passkey-signin]').click();
  const accepted = await assertion;
  assert.equal(accepted.status(), 200, 'real browser assertion verified');
  assert.equal((await accepted.json()).account.id, before.account.id);
  await page.locator('#main').waitFor({ state: 'visible' });
  const replay = await page.context().request.post(origin + '/api/auth/passkey/authenticate/finish', { data: accepted.request().postDataJSON(), headers: { Origin: origin } });
  assert.ok(replay.status() >= 400, 'a consumed assertion cannot be replayed');
});
