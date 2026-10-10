// Auth journeys from the live auth audit (2026-10-09), run against a local
// server with captured mail. Each passing path stays guarded here. A path that
// is still broken on main is a node:test todo entry: it runs and reports but
// doesn't fail CI, and flips to a plain test when its fix lands. Invite signup
// ("check your email") and guest upgrade are guarded by their own scoped suites,
// invite-signup-browser-check.mjs and guest-upgrade-browser-check.mjs.
// Synthetic addresses only; nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { openMagicSignin } from "./signin-browser-journey.mjs";

// The secret-scan allowlist already covers this synthetic fixture password.
const PASSWORD = "synthetic-email-password";
const DESK = { viewport: { width: 1280, height: 860 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function setup(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  let mailer = null;
  const server = createRoomServer({ store: f.store, streamInterval: 40,
    magicLinkMailer: { isConfigured: () => true, sendMagicLink: p => mailer.sendMagicLink(p), sendPasswordResetNotice: p => mailer.sendPasswordResetNotice(p) } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  mailer = createMagicLinkMailer({ baseUrl: origin, send: async payload => { sent.push(payload); } });
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const open = async (kind = DESK) => {
    const page = await (await browser.newContext({ ...kind, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    return page;
  };
  const mailTo = (email, purpose) => sent.filter(m => m.to === email && (purpose === undefined || m.purpose === purpose)).at(-1);
  const session = async page => (await (await page.context().request.get(`${origin}/api/account-session`)).json());
  return { ...f, origin, open, sent, mailTo, session };
}

async function signUp(page, origin, email) {
  await page.goto(origin);
  await page.locator('#auth-signin-ui [data-password-mode="signup"]').first().click();
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(PASSWORD);
  const reply = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/password/signup");
  await form.locator('button[type="submit"]').click();
  return (await reply).status();
}

const visibleCount = (page, text) => page.getByText(text, { exact: false }).evaluateAll(nodes => nodes.filter(n => n.offsetParent !== null).length);

test("signup, then verify by the emailed code; a wrong code is reported once", { timeout: 60000 }, async t => {
  const f = await setup(t);
  const page = await f.open(DESK);
  const email = "journey-verify@example.invalid";
  assert.equal(await signUp(page, f.origin, email), 202);
  await page.locator("#main").waitFor({ state: "visible" });
  const mail = f.mailTo(email, "verify-email") ?? f.mailTo(email);
  assert.ok(mail?.code, "signup sends a verification code");
  await clickChrome(page, "#account-settings-button");
  const code = page.getByLabel("Verification code");
  await code.waitFor();
  await code.fill(mail.code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.getByText("That code is not valid").first().waitFor();
  assert.equal(await visibleCount(page, "That code is not valid"), 1, "the wrong-code error is shown once");
  await code.fill(mail.code);
  const verified = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/email/verify");
  await page.getByRole("button", { name: "Verify email" }).click();
  assert.equal((await verified).status(), 200);
  await page.getByText("Email verified.").waitFor();
  assert.ok(f.store.accountLogins.findAccountByVerifiedEmail(email), "the account's email is verified");
});

test("the verify email's link opens cleanly on a signed-out phone", { timeout: 60000 }, async t => {
  const f = await setup(t);
  const desk = await f.open(DESK);
  const email = "journey-link@example.invalid";
  assert.equal(await signUp(desk, f.origin, email), 202);
  const mail = f.mailTo(email, "verify-email") ?? f.mailTo(email);
  assert.ok(mail?.link, "the verify mail carries a link");
  const phone = await f.open(PHONE);
  await phone.goto(mail.link);
  await phone.locator("#auth-panel").waitFor({ state: "visible" });
  await phone.waitForTimeout(500);
  assert.equal(await visibleCount(phone, "incomplete or invalid"), 0, "no invalid sign-in link error");
});

async function magicLinkReuse(t) {
  const f = await setup(t);
  const desk = await f.open(DESK);
  const email = "journey-magic@example.invalid";
  assert.equal(await signUp(desk, f.origin, email), 202);
  await desk.locator("#main").waitFor({ state: "visible" });
  const other = await f.open(DESK);
  await other.goto(f.origin);
  const form = await openMagicSignin(other);
  await form.locator('[name="email"]').fill(email);
  await form.locator('button[type="submit"]').click();
  await other.getByText(/check/i).first().waitFor();
  const mail = f.mailTo(email);
  assert.ok(mail?.link && !mail.purpose, "a sign-in link was mailed");
  const phone = await f.open(PHONE);
  await phone.goto(mail.link);
  await phone.locator("#main").waitFor({ state: "visible" });
  assert.equal((await f.session(phone)).authenticated, true, "the link signs the phone in");
  const again = await f.open(DESK);
  await again.goto(mail.link);
  await again.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal((await f.session(again)).authenticated, false, "a used link signs nobody in");
  await again.getByText(/not valid|expired|already used/i).first().waitFor();
  return again;
}

test("a magic link signs in on another device once, and reusing it is refused", { timeout: 60000 }, async t => { await magicLinkReuse(t); });

test("on a phone, a wrong password says so and the right one signs in", { timeout: 60000 }, async t => {
  const f = await setup(t);
  const page = await f.open(PHONE);
  const email = "journey-login@example.invalid";
  assert.equal(await signUp(page, f.origin, email), 202);
  await page.locator("#main").waitFor({ state: "visible" });
  const fresh = await f.open(PHONE);
  await fresh.goto(f.origin);
  const login = fresh.locator('#auth-signin-ui [data-signin-form="password"]');
  if (await fresh.locator('#auth-signin-ui [data-password-mode="login"]').first().isVisible()) await fresh.locator('#auth-signin-ui [data-password-mode="login"]').first().click();
  await login.locator('[name="email"]').fill(email);
  await login.locator('[name="password"]').fill(PASSWORD + "-wrong");
  await login.locator('button[type="submit"]').click();
  await fresh.getByText("Invalid email or password").first().waitFor();
  await login.locator('[name="password"]').fill(PASSWORD);
  await login.locator('button[type="submit"]').click();
  await fresh.locator("#main").waitFor({ state: "visible" });
  assert.equal((await f.session(fresh)).authenticated, true);
});

// Still broken on main (auth audit 2026-10-09). Flip to a plain test with its fix.
test("TODO: a reused magic link's refusal is shown once, not twice", { todo: "auth-signin-ui shows it in two alerts (Codex)" }, async t => {
  const again = await magicLinkReuse(t);
  assert.equal(await visibleCount(again, "not valid"), 1);
});
