import { clickChrome } from "./room-chrome.mjs";
// Browser coverage for the account settings UI (slice 7, RC-2026-09-17-016):
// the session menu opens Sign-in & security, the linked methods render with
// honest provider-unconfigured states, disable/enable/remove work through
// the real UI (including the last-active-method guard), and recovery codes
// are generated and shown once. Boots a real server against an
// acceptance-fixture store over loopback; no network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { hashPassword } from "../src/password-auth.mjs";
import { fillAccessKey } from "./auth-signin.mjs";

async function expandSignInOptions(page) {
  const more = page.locator("#signin-more");
  const extra = page.locator("#signin-extra");
  if (await more.count() && await extra.isHidden()) await more.click();
  await extra.waitFor({ state: "visible" });
}

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
  await fillAccessKey(page, key);
  await page.locator('#auth-form button[type="submit"]').click();
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

test("sign-in UI: password signup, magic honest-unconfigured, recovery-code login, GitHub honest-unconfigured", { timeout: 60000 }, async t => {
  const { f, page, origin } = await setup(t);
  // Each flow gets an isolated context: the account cookie must not leak
  // between them, or later pages would load already signed in.
  const freshPage = async () => (await page.context().browser().newContext()).newPage();

  // 1. Email+password create-account through the real UI lands on the account workspace.
  const signup = await freshPage();
  await signup.goto(origin + "/?account=1");
  await expandSignInOptions(signup);
  await signup.getByRole("button", { name: "Email + password" }).click();
  await signup.locator('[data-signin-form="password"] [name="email"]').fill("signin-browser@example.invalid");
  await signup.locator('[data-signin-form="password"] [name="password"]').fill("fixture-password-browser-1");
  await signup.locator('[data-signin-form="password"] button[type="submit"]').click();
  await signup.locator("#inbox-panel").waitFor();
  await signup.locator("#account-setup-dialog").getByRole("heading", { name: "Make Project Room yours" }).waitFor();
  await signup.locator("#account-setup-dialog").getByRole("button", { name: "Set up later" }).click();

  // 2. Magic link is honest when no mail provider is configured.
  const magic = await freshPage();
  await magic.goto(origin + "/?account=1");
  await expandSignInOptions(magic);
  await magic.getByRole("button", { name: "Magic link" }).click();
  await magic.locator('[data-signin-form="magic-request"] [name="email"]').fill("magic-browser@example.invalid");
  await magic.locator('[data-signin-form="magic-request"] button[type="submit"]').click();
  await magic.locator("[data-signin-status]").getByText("Email delivery is not configured", { exact: false }).waitFor();

  // 3. Recovery-code login through the real UI lands on the account workspace.
  const recId = "slice7-browser-recovery";
  f.store.createAccount(recId, "password-signup");
  f.store.accountLogins.linkPasswordMethod(recId, { email: "recovery-browser@example.invalid", verifier: "fixture-verifier" });
  const { codes } = f.store.accountLogins.generateRecoveryCodes(recId);
  assert.ok(codes.length >= 1);
  const recovery = await freshPage();
  await recovery.goto(origin + "/?account=1");
  await expandSignInOptions(recovery);
  await recovery.getByRole("button", { name: "Recovery code" }).click();
  await recovery.locator('[data-signin-form="recovery"] [name="email"]').fill("recovery-browser@example.invalid");
  await recovery.locator('[data-signin-form="recovery"] [name="code"]').fill(codes[0]);
  await recovery.locator('[data-signin-form="recovery"] button[type="submit"]').click();
  await recovery.locator("#inbox-panel").waitFor();
  assert.equal(f.store.accountLogins.recoveryCodesRemaining(recId), codes.length - 1);

  // 4. GitHub sign-in is honestly unavailable: the fixture has no OAuth
  // credentials, so the start route serves a readable landing page instead
  // of sending the user to GitHub.
  const github = await freshPage();
  await github.goto(origin + "/?account=1");
  await expandSignInOptions(github);
  await Promise.all([
    github.waitForURL("**/api/auth/github/start"),
    github.getByRole("button", { name: "Continue with GitHub" }).click(),
  ]);
  await github.getByRole("heading", { name: "GitHub sign-in isn’t configured" }).waitFor();
  await github.getByRole("link", { name: "Back to sign-in" }).click();
  await github.waitForURL("**/?account=1");

  // 5. The passkey form renders (headless Chromium has no authenticator to complete with).
  const passkey = await freshPage();
  await passkey.goto(origin + "/?account=1");
  await expandSignInOptions(passkey);
  await passkey.getByRole("button", { name: "Passkey" }).click();
  await passkey.locator('[data-signin-form="passkey"]').waitFor();
});

test("sign-in UI: magic-link happy path with a configured mailer, password login", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const sent = [];
  const { createMagicLinkMailer } = await import("../server/magic-links.mjs");
  const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  const server = createRoomServer({ store: f.store, magicLinkMailer: mailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
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
  await expandSignInOptions(magic);
  await magic.getByRole("button", { name: "Magic link" }).click();
  await magic.locator('[data-signin-form="magic-request"] [name="email"]').fill("magic-browser@example.invalid");
  await magic.locator('[data-signin-form="magic-request"] button[type="submit"]').click();
  await magic.locator('[data-signin-form="magic-code"]').waitFor();
  // Link-first UI: manual code entry is opt-in behind a toggle.
  await magic.locator('[data-magic-manual-code]').click();
  await magic.locator('[data-signin-form="magic-code"] [name="code"]').waitFor();
  assert.equal(sent.length, 1);
  assert.ok(typeof sent[0].code === "string" && sent[0].code.length > 0);
  await magic.locator('[data-signin-form="magic-code"] [name="code"]').fill(sent[0].code);
  await magic.locator('[data-signin-form="magic-code"] button[type="submit"]').click();
  await magic.locator("#inbox-panel").waitFor();

  // Password login through the real UI (not just signup).
  const pwId = "slice7-browser-password";
  f.store.createAccount(pwId, "password-browser-fixture");
  f.store.accountLogins.linkPasswordMethod(pwId, { email: "pw-browser@example.invalid", verifier: hashPassword("fixture-password-login") });
  const login = await freshPage();
  await login.goto(origin + "/?account=1");
  await expandSignInOptions(login);
  await login.getByRole("button", { name: "Email + password" }).click();
  await login.locator('[data-password-mode="login"]').click();
  await login.locator('[data-signin-form="password"] [name="email"]').fill("pw-browser@example.invalid");
  await login.locator('[data-signin-form="password"] [name="password"]').fill("fixture-password-login");
  await login.locator('[data-signin-form="password"] button[type="submit"]').click();
  await login.locator("#inbox-panel").waitFor();
});
