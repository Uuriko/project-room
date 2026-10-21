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

async function setup(t, { mailConfigured = true } = {}) {
  const f = createAcceptanceFixture();
  const sent = [];
  let mailer = null;
  const server = createRoomServer({ store: f.store, streamInterval: 40,
    magicLinkMailer: { isConfigured: () => mailConfigured, sendMagicLink: p => mailer.sendMagicLink(p), sendPasswordResetNotice: p => mailer.sendPasswordResetNotice(p) } });
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

for (const [label, viewport] of [["desktop", DESK], ["mobile", PHONE]]) {
  test(`late sign-in capabilities preserve typed fields and focus (${label})`, async t => {
    const f = await setup(t), page = await f.open(viewport);
    let resolve; const pending = new Promise(done => { resolve = done; });
    await page.route('**/api/auth/signin-options', route => resolve(route));
    await page.goto(f.origin); const route = await pending;
    const email = page.locator('#auth-signin-ui [name=email]'), password = page.locator('#auth-signin-ui [name=password]');
    await email.fill('draft@example.invalid'); await password.fill(PASSWORD);
    await route.fulfill({ status: 200, json: { providers: { mail: { configured: false } } } });
    await page.waitForFunction(() => document.querySelector('#auth-signin-ui [name=password]')?.required);
    assert.equal(await email.inputValue(), 'draft@example.invalid');
    assert.equal(await password.inputValue(), PASSWORD);
    assert.equal(await password.evaluate(node => node === document.activeElement), true);
  });
}

test('pending password sign-in fences provider navigation until it settles', async t => {
  const f = await setup(t), page = await f.open();
  await page.route('**/api/auth/signin-options', route => route.fulfill({ status: 200, json: { providers: { google: { configured: true } } } }));
  let resolve; const pending = new Promise(done => { resolve = done; });
  await page.route('**/api/auth/password/login', route => resolve(route));
  let oauth = 0;
  await page.route('**/api/auth/google/start', route => { oauth++; return route.fulfill({ status: 200, body: 'Synthetic provider' }); });
  await page.goto(f.origin);
  await page.locator('#auth-signin-ui [name=email]').fill('pending@example.invalid');
  await page.locator('#auth-signin-ui [name=password]').fill(PASSWORD);
  await page.locator('#auth-signin-ui button[type=submit]').click(); const route = await pending;
  assert.equal(await page.locator('#auth-panel').evaluate(node => node.inert), true);
  const box = await page.locator('#google-signin').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(oauth, 0); assert.equal(page.url(), f.origin + '/');
  await route.fulfill({ status: 401, json: { error: { code: 'invalid_credentials', message: 'Invalid credentials' } } });
  await page.waitForFunction(() => document.querySelector('#auth-signin-ui')?.getAttribute('aria-busy') === 'false');
  await page.locator('#google-signin').click(); assert.equal(oauth, 1);
});

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

for (const alreadySignedIn of [true, false]) {
  test(`verification link resumes the existing code form (${alreadySignedIn ? "signed in" : "signed out"})`, { timeout: 60000 }, async t => {
    const f = await setup(t), desk = await f.open(DESK);
    const email = "journey-link@example.invalid";
    assert.equal(await signUp(desk, f.origin, email), 202);
    await desk.locator("#main").waitFor({ state: "visible" });
    const mail = f.mailTo(email, "verify-email") ?? f.mailTo(email);
    const page = alreadySignedIn ? desk : await f.open(PHONE);
    await page.goto(mail.link);
    if (!alreadySignedIn) {
      await page.locator('#auth-signin-ui [name=password]').fill(PASSWORD);
      await page.locator('#auth-signin-ui button[type=submit]').click();
    }
    const code = page.getByLabel("Verification code");
    await code.waitFor({ timeout: 5000 });
    await code.fill(mail.code);
    await page.getByRole("button", { name: "Verify email" }).click();
    await page.getByText("Email verified.").waitFor();
    assert.ok(f.store.accountLogins.findAccountByVerifiedEmail(email));
    await page.goto(mail.link);
    await page.locator("#main:visible, #account-rooms-panel:visible").first().waitFor();
    assert.equal(await page.getByLabel("Verification code").isVisible(), false,
      "an already verified account must not reopen the code form");
  });
}

test("verification navigation does not select a different signed-in account", async t => {
  const f = await setup(t), first = await f.open(DESK), second = await f.open(PHONE);
  await signUp(first, f.origin, "verification-first@example.invalid");
  await first.locator("#main").waitFor({ state: "visible" });
  const mail = f.mailTo("verification-first@example.invalid");
  await signUp(second, f.origin, "verification-second@example.invalid");
  await second.locator("#main").waitFor({ state: "visible" });
  await second.goto(mail.link);
  await second.locator("#main").waitFor({ state: "visible" });
  assert.equal(await second.getByLabel("Verification code").isVisible(), false);
  assert.equal(await second.evaluate(() => sessionStorage.getItem("project-room:verify-email:v1")), null);
});

for (const [label, viewport] of [["desktop", DESK], ["mobile", PHONE]]) test(`a failed methods read during verification resume still lands the signed-in tab (${label})`, { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.open(viewport);
  const email = "journey-resume-error@example.invalid";
  assert.equal(await signUp(page, f.origin, email), 202);
  await page.locator("#main").waitFor({ state: "visible" });
  const mail = f.mailTo(email, "verify-email") ?? f.mailTo(email);
  const account = (await f.session(page)).account.id;
  // Service outage while the link's intent is stored.
  await page.route("**/api/auth/methods", route => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Synthetic outage" } } }));
  await page.goto(mail.link);
  await page.locator("#main").waitFor({ state: "visible" });
  // A later plain load of the same tab is not held hostage by the stored intent.
  await page.goto(f.origin);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-panel").isVisible(), false);
  assert.equal((await f.session(page)).account.id, account, "recovery must preserve the signed-in account");
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

// Refusal must remain singular across the outer panel and mounted sign-in form.
test("a reused magic link's refusal is shown once, not twice", async t => {
  const again = await magicLinkReuse(t);
  assert.equal(await visibleCount(again, "not valid"), 1);
});

for (const theme of ["dark", "light"]) for (const kind of [DESK, PHONE]) test(`fresh sign-in stays independent of workspace modules: ${theme}, ${kind.viewport.width}px`, async t => {
  const f = await setup(t), page = await f.open(kind), requests = [];
  await page.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.goto(f.origin);
  const form = page.locator('[data-signin-form="password"]');
  await form.waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle");
  assert.equal(requests.includes("/src/app.js"), false, "workspace stays unloaded at first paint and idle");
  for (const path of ["/src/client.js", "/src/events.js", "/src/legacy-reaction-aliases.js", "/src/workspace-navigation.js", "/src/request-access.js"])
    assert.equal(requests.includes(path), false, path);
  // Agent sign-in is the standalone /agent-signin page on current main
  // (decision #37): the wall button is a link there, and the page's own
  // "Back to log in" link returns. (Integration: the PR's original leg used
  // the pre-#3445 in-page panel's #agent-auth-back.)
  await page.locator("#agent-signin-button").click();
  await page.locator("#agent-signin-ui input").first().waitFor({ state: "visible" });
  await page.locator("#agent-signin-home").click();
  await form.waitFor({ state: "visible" });
  await form.locator('[name="email"]').fill("entry-draft@example.invalid");
  await page.locator("[data-forgot-password]").click();
  await page.evaluate(() => history.back());
  await form.waitFor({ state: "visible" });
  assert.equal(await form.locator('[name="email"]').inputValue(), "entry-draft@example.invalid");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(requests.includes("/src/app.js"), false, "account and agent controls do not import workspace code");
  await page.screenshot({ path: `test-results/signin-entry-${theme}-${kind.viewport.width}.png` });
});

// Regression (Codex review of the #3068 integration, 2026-10-14): the lazy
// entry must learn the deployment's sign-in capabilities like the workspace
// app does (GET /api/auth/signin-options). Without the loader the entry's
// auth UI defaults to mail-configured and offers an email sign-in link on
// deployments that cannot send mail. Fresh query-free / only — the
// /?room=… workspace path never had the gap.
async function freshEntryRecoveryOffers(t, mailConfigured) {
  const f = await setup(t, { mailConfigured });
  const page = await f.open(DESK);
  const requests = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  const optionsReply = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/signin-options");
  await page.goto(f.origin);
  await page.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
  await optionsReply;
  await page.locator("[data-forgot-password]").click();
  await page.locator('[data-signin-form="reset-request"]').waitFor({ state: "visible" });
  return { page, requests };
}

test("fresh / with mail unconfigured: the entry loads signin-options and offers no email link", async t => {
  const { page, requests } = await freshEntryRecoveryOffers(t, false);
  assert.ok(requests.includes("/api/auth/signin-options"), "the lazy entry requests the deployment's sign-in options");
  assert.equal(await page.locator('[data-email-method="magic"]:visible').count(), 0, "no email-link offer when the deployment cannot send mail");
});

test("fresh / with mail configured: the entry still offers the email link", async t => {
  const { page, requests } = await freshEntryRecoveryOffers(t, true);
  assert.ok(requests.includes("/api/auth/signin-options"), "the lazy entry requests the deployment's sign-in options");
  assert.equal(await page.locator('[data-email-method="magic"]:visible').count(), 1, "the email-link offer stays when mail is configured");
});

test("a failed workspace download after signup resumes the same account without repeating signup", { timeout: 45000 }, async t => {
  const f = await setup(t), page = await f.open(PHONE), writes = [];
  page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
  await page.route("**/src/app.js", route => route.abort());
  const email = "entry-recovery@example.invalid";
  assert.equal(await signUp(page, f.origin, email), 202);
  await page.locator("#entry-retry").waitFor({ state: "visible" });
  const account = (await f.session(page)).account.id;
  await page.unroute("**/src/app.js");
  await page.locator("#entry-retry").click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal((await f.session(page)).account.id, account);
  assert.equal(writes.filter(path => path === "/api/auth/password/signup").length, 1);
  assert.equal(await page.locator("#auth-signin-ui").count(), 1);
  await page.locator("#message-input").fill("A draft after entering the room");
  await page.locator('#message-form button[type="submit"]').click();
  await page.locator("#message-list").getByText("A draft after entering the room", { exact: true }).waitFor();
  assert.equal(writes.filter(path => /\/commands$/.test(path)).length, 1, "one composer handler after the handoff");
});

test("a failed sign-in module download offers reload without losing the URL", async t => {
  const f = await setup(t), page = await f.open(PHONE);
  await page.route("**/src/signin-entry.js", route => route.abort());
  await page.goto(f.origin);
  await page.locator("#entry-retry").waitFor({ state: "visible" });
  assert.equal(page.url(), f.origin + "/");
  await page.unroute("**/src/signin-entry.js");
  await page.locator("#entry-retry").click();
  await page.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
});

test("cached HTML that names app.js directly still starts the existing workspace", async t => {
  const f = await setup(t), page = await f.open();
  await page.route(f.origin + "/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('src="./src/entry.js"', 'src="./src/app.js"');
    await route.fulfill({ response, body });
  });
  await page.goto(f.origin);
  await page.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-signin-ui").count(), 1);
});

test("an incoming room link owns navigation while its workspace module downloads", async t => {
  const f = await setup(t), page = await f.open(), requests = [];
  await page.goto(f.origin);
  await page.locator('[data-signin-form="password"]').waitFor({ state: "visible" });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/src/app.js", route => release(route));
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.evaluate(() => { location.hash = "#room/commons"; });
  const route = await held;
  assert.equal(await page.locator("#auth-panel").evaluate(node => node.inert), true);
  assert.equal(await page.locator("#session-menu-button").isDisabled(), true, "account controls wait for their handlers");
  const button = await page.locator('[data-signin-form="password"] button[type="submit"]').boundingBox();
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  assert.equal(requests.some(path => path.startsWith("/api/auth/")), false, "old sign-in cannot replace pending entry");
  await route.continue();
  await page.waitForFunction(() => !document.querySelector("#auth-panel").inert);
  assert.equal(await page.locator("#session-menu-button").isEnabled(), true);
  assert.match(page.url(), /#room\/commons$/);
});
