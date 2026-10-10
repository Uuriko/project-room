// Guest upgrade in a real browser (auth audit 2026-10-09, path 13), at desktop
// and 390px phone sizes: a guest who joined from a link adds an email, enters
// the mailed code with a password, and later signs in to the same account and
// room. A second guest with no email deletes the account by typing DELETE.
// Local server, captured mail, synthetic addresses only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { clickChrome } from "./room-chrome.mjs";

const PASSWORD = "synthetic-guest-upgrade-pw";
const SIZES = [["desktop", { viewport: { width: 1280, height: 860 } }], ["390px phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]];

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
  const open = async size => {
    const page = await (await browser.newContext({ ...size, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    return page;
  };
  const session = async page => (await (await page.context().request.get(`${origin}/api/account-session`)).json());
  return { ...f, origin, open, sent, session };
}

async function joinAsGuest(f, page, name) {
  await page.goto(`${f.origin}/#join/${f.links.valid}`);
  const guestButton = page.getByRole("button", { name: "Continue as guest", exact: true });
  await guestButton.waitFor();
  if (!(await page.locator("#join-link-name").isVisible())) await guestButton.click();
  await page.locator("#join-link-name").fill(name);
  await page.locator("#join-link-submit").click();
  await page.locator("#join-link-dialog").waitFor({ state: "hidden" });
  await page.locator("#main").waitFor({ state: "visible" });
  const account = (await f.session(page)).account?.id;
  assert.match(account ?? "", /^guest-/, "joined as a guest account");
  await clickChrome(page, "#account-settings-button");
  return account;
}

for (const [label, size] of SIZES) {
  test(`(${label}) a guest keeps the account with an email and password, then signs back in to the same rooms`, { timeout: 60000 }, async t => {
    const f = await setup(t);
    const page = await f.open(size);
    const account = await joinAsGuest(f, page, "Gus");
    const email = `gus-${size.isMobile ? "phone" : "desk"}@example.invalid`;
    const start = page.locator('form[data-form="guest-upgrade"]');
    await start.waitFor({ state: "visible" });
    assert.equal(await page.locator('form[data-form="password-set"]').count(), 0, "no dead-end Set a password");
    await start.getByLabel("Email").fill(email);
    await start.getByRole("button", { name: "Send code" }).click();
    const confirm = page.locator('form[data-form="guest-upgrade-confirm"]');
    await confirm.waitFor({ state: "visible" });
    await page.getByText("Check your email for a 6-digit code").first().waitFor();
    const code = f.sent.filter(m => m.to === email && m.purpose === "email-verify").at(-1)?.code;
    assert.ok(code, "a code was mailed");
    await confirm.getByLabel("Code").fill(code);
    await confirm.getByLabel("Password").fill(PASSWORD);
    await confirm.getByRole("button", { name: "Keep account" }).click();
    await page.getByText("Account kept.").first().waitFor();
    assert.equal(f.store.accountLogins.emailVerification(account).status, "verified");
    const later = await f.open(size);
    await later.goto(f.origin);
    const login = later.locator('#auth-signin-ui [data-signin-form="password"]');
    if (await later.locator('#auth-signin-ui [data-password-mode="login"]').first().isVisible()) await later.locator('#auth-signin-ui [data-password-mode="login"]').first().click();
    await login.locator('[name="email"]').fill(email);
    await login.locator('[name="password"]').fill(PASSWORD);
    await login.locator('button[type="submit"]').click();
    await later.locator("#main").waitFor({ state: "visible" });
    assert.equal((await f.session(later)).account?.id, account, "signs in to the same account");
    const rooms = f.store.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=?").all(account).map(r => r.room_id);
    assert.ok(rooms.includes("commons"), "still a member of the room it joined as a guest");
  });
}

test("(390px phone) a guest with no email deletes the account by typing DELETE", { timeout: 60000 }, async t => {
  const f = await setup(t);
  const page = await f.open(SIZES[1][1]);
  await joinAsGuest(f, page, "Dee");
  await page.locator('[data-action="delete-account"]').click();
  const dialog = page.locator("[data-deletion-dialog]");
  const input = dialog.getByLabel("Type DELETE to confirm");
  await input.waitFor({ state: "visible" });
  const submit = dialog.locator('form[data-form="delete-account"] button[type="submit"]');
  await input.fill("delet");
  assert.equal(await submit.isDisabled(), true);
  await input.fill("DELETE");
  assert.equal(await submit.isDisabled(), false);
  const deleted = page.waitForResponse(r => new URL(r.url()).pathname === "/api/account/delete");
  await submit.click();
  assert.equal((await deleted).status(), 200);
});
