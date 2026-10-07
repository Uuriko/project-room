// Real local email/password journeys through the contextual email step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { hashPassword } from "../src/password-auth.mjs";
import { clickChrome } from "./room-chrome.mjs";

const password = "synthetic-email-password";
async function setup(t, { login = true } = {}) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin);
  await page.locator('#auth-signin-ui [data-password-mode="signup"]').waitFor({ state: "visible" });
  if (login) {
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    assert.equal(await page.locator('#auth-signin-ui [name="email"]').evaluate(node => node === document.activeElement), true, "explicit Log in focuses the visible email field");
  }
  return { ...f, page, origin };
}

test("contextual email creation signs in using the actual password signup API", { timeout: 25000 }, async t => {
  const { page, origin, store } = await setup(t), email = "new-email-password@example.invalid";
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  assert.equal(await form.locator('[name="password"]').getAttribute("autocomplete"), "current-password");
  await form.locator('[data-password-mode="signup"]').click();
  assert.equal(await form.locator('[name="email"]').evaluate(node => node === document.activeElement), true, "explicit account creation preserves email focus");
  await form.locator('[name="email"]').fill(email); await form.locator('[name="password"]').fill(password);
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/password/signup");
  await form.locator('button[type="submit"]').click();
  assert.equal((await reply).status(), 202);
  await page.locator("#auth-panel").waitFor({ state: "hidden" });
  const actual = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(actual.authenticated, true);
  assert.equal(store.accountLogins.findPasswordAccount(email), actual.account.id);
  assert.equal(store.accountLogins.findAccountByVerifiedEmail(email), null);
  assert.doesNotMatch(page.url(), /password=|new-email-password/);
});

test("password signup opens one personal room without optional setup, with profile editing available later", { timeout: 40000 }, async t => {
  const { page, origin } = await setup(t, { login: false });
  const shots = "test-results/onboarding";
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => {
    window.signupButtonClicks = [];
    document.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button) window.signupButtonClicks.push(button.textContent.trim());
    });
  });
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await form.locator('[name="email"]').fill("room-landing@example.invalid");
  await form.locator('[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  await page.locator("#main").waitFor({ state: "visible", timeout: 3000 });
  assert.equal(await page.locator('#account-setup-dialog').isVisible(), false, 'optional naming does not block the first conversation');
  assert.deepEqual(await page.evaluate(() => window.signupButtonClicks), ['Create account', 'Create account']);
  assert.match(page.url(), /[?&]room=personal-/);
  assert.equal(await page.locator("#inbox-panel").isVisible(), false);
  assert.equal(await page.locator("#identity-label").textContent(), "Owner", 'the existing default identity remains intact');
  const account = await (await page.context().request.get(origin + '/api/account-session')).json();
  assert.equal(account.authenticated, true); assert.equal(account.terms.required, false);
  const rooms = async () => (await (await page.context().request.get(origin + '/api/account-rooms', { headers: { 'X-Session-Binding': account.sessionBinding } })).json()).rooms;
  assert.equal((await rooms()).length, 1, 'automatic first-room creation stays singular');
  const initialRoom = new URL(page.url()).searchParams.get('room');
  await page.reload(); await page.locator('#main').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#account-setup-dialog').isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.get('room'), initialRoom);
  assert.equal((await rooms()).length, 1, 'reload cannot create another room');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${shots}/first-run-1280.png` });
  await clickChrome(page, '#account-settings-button');
  await page.locator('#nav-inbox').click(); await page.locator('#inbox-panel').waitFor({ state: 'visible' });
  await page.locator('.inbox-gmail details > summary').click();
  await page.locator('#inbox-setup').click();
  await page.locator('#setup-name').fill('Ada');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('#account-setup-dialog').waitFor({ state: 'hidden' });
  const profile = await (await page.context().request.get(origin + '/api/account/profile', { headers: { 'X-Session-Binding': account.sessionBinding } })).json();
  assert.equal(profile.displayName, 'Ada', 'explicit later personalization persists the account profile');
  assert.equal((await rooms()).length, 1, 'profile editing cannot duplicate the workspace');
});

test("contextual email login reports a rejected password then signs into the existing account", { timeout: 25000 }, async t => {
  const { page, origin, store } = await setup(t), email = "existing-email-password@example.invalid";
  store.createAccount("existing-password-account"); store.completeOnboarding("existing-password-account");
  store.accountLogins.linkPasswordMethod("existing-password-account", { email, verifier: hashPassword(password) });
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await form.locator('[name="email"]').fill(email); await form.locator('[name="password"]').fill("wrong-synthetic-password");
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/password/login");
  await form.locator('button[type="submit"]').click(); assert.equal((await rejected).status(), 401);
  await page.locator('#auth-signin-ui [data-signin-status].error').waitFor();
  assert.equal(await form.locator('[name="password"]').inputValue(), "", "failed password is never repainted");
  await form.locator('[name="password"]').fill(password);
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/password/login");
  await form.locator('button[type="submit"]').click(); assert.equal((await accepted).status(), 200);
  await page.locator("#auth-panel").waitFor({ state: "hidden" });
  const actual = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(actual.authenticated, true); assert.equal(actual.account.id, "existing-password-account");
});

test("signup guidance, password visibility and pending-write controls work before native browser consent resumes", { timeout: 40000 }, async t => {
  const { page, origin } = await setup(t);
  const { createHash } = await import("node:crypto");
  const verifier = "v".repeat(43), state = "s".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await page.goto(`${origin}/api/auth/desktop/start?state=${state}&challenge=${challenge}`);
  await page.locator('[data-password-mode="signup"]').click();
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  assert.equal(await form.locator('[name="password"]').getAttribute("minlength"), "10");
  assert.match(await form.locator("#signup-password-hint").textContent(), /10–256/);
  await form.locator('[name="email"]').fill("native-browser-signup@example.invalid");
  await form.locator('[name="password"]').fill(password);
  await form.locator('[data-password-visibility]').click();
  assert.equal(await form.locator('[name="password"]').getAttribute("type"), "text");
  assert.equal(await form.locator('[name="password"]').inputValue(), password);
  await form.locator('[data-password-visibility]').click();
  assert.equal(await form.locator('[name="password"]').getAttribute("type"), "password");
  let held;
  const routed = new Promise(resolve => { held = resolve; });
  await page.route("**/api/auth/password/signup", route => held(route));
  await form.locator('button[type="submit"]').click();
  const route = await routed;
  assert.equal(await page.locator("#auth-signin-ui").getAttribute("aria-busy"), "true");
  assert.equal(await form.locator("button:enabled, input:enabled").count(), 0);
  assert.match(await form.locator('button[type="submit"]').textContent(), /Creating account/);
  await route.continue();
  await page.waitForURL(/\/oauth\/authorize\?/);
  assert.match(await page.locator("h1").textContent(), /Project Room for Mac/);
  assert.match(await page.locator("li").textContent(), /account controls/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("project-room:oauth-return:v1")), null, "return target is consumed");
  assert.doesNotMatch(page.url(), /password=/);
  const consent = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/oauth/authorize");
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  const decision = await consent;
  assert.equal(decision.status(), 302, "the browser's actual consent form passes Origin and CSRF checks");
  const callback = new URL(decision.headers().location, origin);
  assert.equal(callback.searchParams.get("state"), state);
  const mac = await page.context().request.post(`${origin}/api/auth/desktop/session`, {
    headers: { Origin: origin, Cookie: "" }, data: { code: callback.searchParams.get("code"), verifier }
  });
  assert.equal(mac.status(), 201);
});
