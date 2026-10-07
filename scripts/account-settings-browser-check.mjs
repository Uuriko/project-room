import { openMagicSignin } from "./signin-browser-journey.mjs";
import { clickChrome } from "./room-chrome.mjs";
// Browser coverage for the account settings UI (slice 7, RC-2026-09-17-016):
// the session menu opens Sign-in & security, the linked methods render with
// honest provider-unconfigured states, disable/enable/remove work through
// the real UI (including the last-active-method guard), and recovery codes
// are generated and shown once. Boots a real server against an
// acceptance-fixture store over loopback; no network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { hashPassword } from "../src/password-auth.mjs";
import { signInFixture } from "./auth-signin.mjs";

async function setup(t) {
  const f = createAcceptanceFixture();
  const accountId = "slice7-browser";
  f.store.createAccount(accountId, "settings-browser-fixture");
  f.store.completeOnboarding(accountId); // Existing-account settings journey; first-run setup has its own browser coverage.
  f.store.accountLogins.linkPasswordMethod(accountId, { email: "browser@example.invalid", verifier: "fixture-verifier" });
  f.store.accountLogins.linkMagicMethod(accountId, { email: "browser@example.invalid" });
  const key = f.store.issueAccountAccessKey(accountId);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [], outside = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { f, page, origin, key, accountId };
}

const methodRow = (page, label) => page.locator(".settings-method", { hasText: label });

test("account settings: methods render, disable/enable/remove, recovery codes, honest provider states", { timeout: 45000 }, async t => {
  const { page, origin, key, accountId, f } = await setup(t);
  await page.goto(origin + "/?account=1");
  await signInFixture(page, key);
  await page.locator("#inbox-panel").waitFor();

  // Desktop topbar exposes Sign-in & security directly (the session-menu
  // fold is mobile-only).
  await clickChrome(page, "#account-settings-button");
  const body = page.locator("#account-settings-body");
  await body.getByText("Linked sign-in methods").waitFor();

  // Both linked methods render with safe public detail.
  await body.getByText("Password").first().waitFor();
  await body.getByText("Email magic link").waitFor();
  assert.ok((await body.textContent()).includes("browser@example.invalid"));

  // Honest provider-unconfigured states (no OAuth or mail bindings in the fixture).
  for (const note of ["GitHub sign-in isn’t configured on this Room.",
    "Google sign-in isn’t configured on this Room.", "Email delivery isn’t configured on this Room"]) {
    await body.getByText(note, { exact: false }).first().waitFor();
  }

  // Disable the magic method through the real UI.
  await methodRow(page, "Email magic link").getByRole("button", { name: "Disable" }).click();
  await methodRow(page, "Email magic link").getByText("disabled").waitFor();

  // The last active method cannot be disabled: the guard message surfaces.
  await methodRow(page, "Password").getByRole("button", { name: "Disable" }).click();
  await body.getByText("Keep at least one active sign-in method").waitFor();

  // Re-enable, then remove the disabled magic method (confirm auto-accepted).
  await methodRow(page, "Email magic link").getByRole("button", { name: "Enable" }).click();
  await methodRow(page, "Email magic link").getByRole("button", { name: "Disable" }).waitFor();
  await methodRow(page, "Email magic link").getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".settings-method")].some(li => li.textContent.includes("Email magic link")));
  assert.equal(f.store.accountLogins.listMethods(accountId).some(m => m.type === "magic"), false);

  // Removing the last active method is refused in the UI too.
  await methodRow(page, "Password").getByRole("button", { name: "Remove" }).click();
  await body.getByText("Keep at least one active sign-in method").waitFor();
  assert.equal(f.store.accountLogins.listMethods(accountId).some(m => m.type === "password"), true);

  // Recovery codes generate and display exactly once.
  await body.getByRole("button", { name: "Generate recovery codes" }).click();
  await body.locator("[data-recovery-codes] code").first().waitFor();
  const codes = await body.locator("[data-recovery-codes] code").allTextContents();
  assert.equal(codes.length, 10);
  assert.ok(codes.every(code => /^[a-z0-9_-]{8}-[a-z0-9_-]{8}$/.test(code)));
});

test("email sign-in reports unconfigured delivery without pretending to send", { timeout: 30000 }, async t => {
  const { page, origin } = await setup(t);
  await page.goto(origin + "/?account=1");
  await openMagicSignin(page);
  const form = page.locator('#auth-signin-ui [data-signin-form="magic-request"]');
  await form.locator('[name="email"]').fill("magic-browser@example.invalid");
  await form.locator('button[type="submit"]').click();
  await page.locator('#auth-signin-ui [data-signin-status]').filter({ hasText: /not configured|isn.t configured/i }).waitFor();
  assert.equal(await page.locator("#auth-panel").isVisible(), true);
  assert.equal(await page.locator("#inbox-panel").isVisible(), false);
});

test("sign-in UI: email link returns to the existing account with a configured mailer", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const sent = [];
  const { createMagicLinkMailer } = await import("../server/magic-links.mjs");
  const mailer = { isConfigured: () => true, sendMagicLink: payload => configuredMailer.sendMagicLink(payload) };
  const server = createRoomServer({ store: f.store, magicLinkMailer: mailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const configuredMailer = createMagicLinkMailer({ baseUrl: origin, send: async payload => sent.push(payload) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const freshPage = async () => (await browser.newContext()).newPage();

  // Magic happy path: account with a magic method, request a code through
  // the real UI, read the code from the synthetic mailer, consume it.
  const magicId = "slice7-browser-magic";
  f.store.createAccount(magicId, "magic-browser-fixture");
  f.store.accountLogins.linkMagicMethod(magicId, { email: "magic-browser@example.invalid" });
  const magic = await freshPage();
  await magic.goto(origin + "/?account=1");
  await openMagicSignin(magic);
  await magic.locator('#auth-signin-ui [data-signin-form="magic-request"] [name="email"]').fill("magic-browser@example.invalid");
  await magic.locator('#auth-signin-ui [data-signin-form="magic-request"] button[type="submit"]').click();
  await magic.locator("#email-auth-panel").getByText(/Check .* for your sign-in link/).waitFor();
  assert.equal(sent.length, 1);
  assert.ok(typeof sent[0].code === "string" && sent[0].code.length > 0);
  assert.equal(typeof sent[0].link, "string");
  await magic.goto(sent[0].link);
  await magic.locator("#inbox-panel").waitFor();
  const account = await magic.request.get(origin + "/api/account-session");
  assert.equal((await account.json()).account.id, magicId, "email verification returns the existing account");
  assert.doesNotMatch(magic.url(), /magic=/, "one-use credential is stripped from the URL");
});


for (const width of [1280, 390]) test(`Profile opens directly from chat and saves account name without changing room identity or draft at ${width}px`, { timeout: 30000 }, async t => {
  const { page, origin, f } = await setup(t);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const signup = page.locator('[data-signin-form="password"]');
  await signup.locator('[name="email"]').fill('direct-profile@example.invalid');
  await signup.locator('[name="password"]').fill('synthetic-profile-password');
  await signup.locator('button[type="submit"]').click();
  await page.locator('#main').waitFor({ state: 'visible' });
  const account = await (await page.context().request.get(origin + '/api/account-session')).json();
  const roomUrl = page.url(), roomIdentity = await page.locator('#identity-label').textContent();
  await page.locator('#message-input').fill('Keep this unsent draft');
  await page.evaluate(() => { window.profileClicks = []; document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (button) window.profileClicks.push(button.id || button.textContent.trim());
  }); });
  await page.locator('#session-menu-button').click();
  assert.equal(await page.locator('#account-profile-button').isVisible(), true, 'account menu exposes a direct profile entry');
  await page.locator('#account-profile-button').click();
  const dialog = page.locator('#account-profile-dialog');
  await dialog.locator('[name="displayName"]').fill('Ada "/><script>window.profileXss=1</script>');
  mkdirSync('test-results/direct-profile', { recursive: true });
  await page.screenshot({ path: `test-results/direct-profile/profile-${width}.png` });
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/account/profile' && r.request().method() === 'POST');
  await dialog.locator('button[type="submit"]').click();
  assert.equal((await saved).status(), 200);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(f.store.accountProfile(account.account.id).displayName, 'Ada "/><script>window.profileXss=1</script>');
  assert.deepEqual(await page.evaluate(() => window.profileClicks), ['session-menu-button', 'account-profile-button', 'Save']);
  assert.equal(await page.locator('#main').isVisible(), true);
  assert.equal(page.url(), roomUrl);
  assert.equal(await page.locator('#message-input').inputValue(), 'Keep this unsent draft');
  assert.equal(await page.locator('#identity-label').textContent(), roomIdentity);
  await page.waitForFunction(() => document.activeElement === document.querySelector('#session-menu-button'));
  assert.equal(await page.locator('#session-menu-button').evaluate(el => el === document.activeElement), true);
  await page.locator('#session-menu-button').click();
  await page.locator('#account-profile-button').click();
  await dialog.locator('[name="displayName"]').waitFor();
  assert.equal(await dialog.locator('[name="displayName"]').inputValue(), 'Ada "/><script>window.profileXss=1</script>', 'saved untrusted text is escaped when editing again');
  assert.equal(await dialog.locator('script').count(), 0);
  await dialog.locator('[name="displayName"]').fill('Ada keyboard');
  const keyboardSaved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/account/profile' && r.request().method() === 'POST');
  await dialog.locator('[name="displayName"]').press('Enter');
  assert.equal((await keyboardSaved).status(), 200);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(f.store.accountProfile(account.account.id).displayName, 'Ada keyboard');
  assert.equal(await page.locator('#message-input').inputValue(), 'Keep this unsent draft');
});


for (const method of ['GET', 'POST']) test(`Profile ignores a held ${method} response after switching accounts`, { timeout: 30000 }, async t => {
  const { page, origin, f, key, accountId } = await setup(t);
  f.store.updateAccountProfile(accountId, { displayName: 'Old private account name' });
  f.store.createAccount('profile-next-account'); f.store.completeOnboarding('profile-next-account');
  f.store.updateAccountProfile('profile-next-account', { displayName: 'Next private account name' });
  f.store.accountLogins.linkPasswordMethod('profile-next-account', { email: 'profile-next@example.invalid', verifier: hashPassword('synthetic-next-password') });
  await page.goto(origin + '/?account=1'); await signInFixture(page, key);
  await page.locator('#inbox-panel').waitFor({ state: 'visible' });
  let captured, release;
  const committed = new Promise(resolve => { captured = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let oldRequest;
  const delivered = new Promise(resolve => page.on('requestfinished', request => { if (request === oldRequest) resolve(); }));
  await page.route('**/api/account/profile', async route => {
    if (route.request().method() !== method || oldRequest) return route.continue();
    oldRequest = route.request();
    const response = await route.fetch(); captured(response.status());
    await held; await route.fulfill({ response });
  });
  await page.locator('#session-menu-button').click();
  await page.locator('#account-profile-button').click();
  if (method === 'POST') {
    const form = page.locator('#account-profile-dialog form');
    await form.locator('[name="displayName"]').fill('Old account committed edit');
    await form.locator('button[type="submit"]').click();
  }
  assert.equal(await committed, 200, 'the held response comes from the real authenticated profile API');
  await page.locator('#account-profile-close').click();
  await clickChrome(page, '#signout-button');
  await page.locator('#auth-panel').waitFor({ state: 'visible' });
  if (await page.locator('[data-password-mode="login"]').isVisible()) await page.locator('[data-password-mode="login"]').click();
  const login = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await login.locator('[name="email"]').fill('profile-next@example.invalid');
  await login.locator('[name="password"]').fill('synthetic-next-password');
  await login.locator('button[type="submit"]').click();
  await page.locator('#auth-panel').waitFor({ state: 'hidden' });
  await page.locator('#session-menu-button').click();
  await page.locator('#account-profile-button').click();
  const current = page.locator('#account-profile-dialog [name="displayName"]');
  await current.waitFor(); assert.equal(await current.inputValue(), 'Next private account name');
  release(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#account-profile-dialog').isVisible(), true, 'old save cannot close the new account editor');
  assert.equal(await current.inputValue(), 'Next private account name', 'old GET cannot repaint a new account profile');
  assert.doesNotMatch(await page.locator('#account-profile-dialog').textContent(), /Old private account/);
  assert.equal(f.store.accountProfile('profile-next-account').displayName, 'Next private account name');
  if (method === 'POST') assert.equal(f.store.accountProfile(accountId).displayName, 'Old account committed edit', 'an already committed save belongs only to the original account');
});
