// Real local email/password journeys through the contextual email step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { hashPassword } from "../src/password-auth.mjs";

const password = "synthetic-email-password";
async function setup(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin);
  return { ...f, page, origin };
}

test("contextual email creation signs in using the actual password signup API", { timeout: 25000 }, async t => {
  const { page, origin, store } = await setup(t), email = "new-email-password@example.invalid";
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  assert.equal(await form.locator('[name="password"]').getAttribute("autocomplete"), "current-password");
  await form.locator('[data-password-mode="signup"]').click();
  await form.locator('[name="email"]').fill(email); await form.locator('[name="password"]').fill(password);
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/password/signup");
  await form.locator('button[type="submit"]').click();
  assert.equal((await reply).status(), 201);
  await page.locator("#auth-panel").waitFor({ state: "hidden" });
  const actual = await (await page.context().request.get(`${origin}/api/account-session`)).json();
  assert.equal(actual.authenticated, true);
  assert.equal(store.accountLogins.findAccountByVerifiedEmail(email), actual.account.id);
  assert.doesNotMatch(page.url(), /password=|new-email-password/);
});

test("password signup lands in the personal room", { timeout: 40000 }, async t => {
  const { page } = await setup(t);
  const shots = "/opt/cursor/artifacts/screenshots";
  mkdirSync(shots, { recursive: true });
  const email = "room-landing@example.invalid";
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await form.locator('[data-password-mode="signup"]').click();
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  const setupName = page.locator("#setup-name");
  await setupName.waitFor({ state: "visible" });
  await setupName.fill("Ada");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForURL(/[?&]room=personal-/);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#inbox-panel").isVisible(), false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${shots}/first-run-1280.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/first-run-390.png` });
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
