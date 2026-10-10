// Invite signup follow-ups to #2318 (auth audit 2026-10-09, A20), in a real
// browser at desktop 1280 and phone 390. Someone opens a friend's invite,
// creates an account from the join dialog, and must (a) see "Check your
// email" in that dialog, (b) join without re-typing a guest name, and (c) get
// a resent code whose link still leads back to the invitation.
// Local server, captured mail, synthetic addresses only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const PW = "synthetic-invitee-password";
const SIZES = [["desktop 1280", { viewport: { width: 1280, height: 860 } }], ["phone 390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]];

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
    return page;
  };
  const verifyMails = email => sent.filter(m => m.to === email && m.purpose === "email-verify");
  const session = async page => (await (await page.context().request.get(`${origin}/api/account-session`)).json());
  return { ...f, origin, open, verifyMails, session };
}

async function signUpFromInvite(f, page, email) {
  await page.goto(`${f.origin}/#join/${f.links.valid}`);
  if (await page.locator("#join-account-signin").isVisible()) await page.locator("#join-account-signin").click();
  const auth = page.locator("#join-account-auth");
  await auth.waitFor({ state: "visible" });
  await auth.locator('[data-password-mode="signup"]').first().click();
  await auth.locator('[name="email"]').fill(email);
  await auth.locator('[name="password"]').fill(PW);
  const reply = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/password/signup");
  await auth.locator('button[type="submit"]').click();
  assert.equal((await reply).status(), 202);
}

for (const [label, size] of SIZES) {
  test(`(${label}) after signing up from an invite, the join dialog says to check email and joins without a guest name`, { timeout: 60000 }, async t => {
    const f = await setup(t);
    const page = await f.open(size);
    const email = `invitee-${size.isMobile ? "phone" : "desk"}@example.invalid`;
    await signUpFromInvite(f, page, email);
    const dialog = page.locator("#join-link-dialog");
    await dialog.waitFor({ state: "visible" });
    // (a) The notice is visible where the person is, not in the hidden panel.
    await dialog.getByText("Check your email for a verification code").waitFor({ state: "visible" });
    // (b) A signed-in account is not asked to type a guest name.
    const name = page.locator("#join-link-name");
    assert.notEqual((await name.inputValue()).trim(), "", "the name is prefilled for a signed-in account");
    const joined = page.waitForResponse(r => new URL(r.url()).pathname === "/api/share-links/join" && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Join room" }).click();
    assert.ok((await joined).ok(), "Join room works straight away");
    await page.locator("#main").waitFor({ state: "visible" });
    const account = (await f.session(page)).account?.id;
    const rooms = f.store.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=?").all(account).map(r => r.room_id);
    assert.ok(rooms.includes("commons"), "the new account is in the invited room");
  });

  test(`(${label}) a resent code from the join dialog still links back to the invitation`, { timeout: 60000 }, async t => {
    const f = await setup(t);
    const page = await f.open(size);
    const email = `resend-${size.isMobile ? "phone" : "desk"}@example.invalid`;
    await signUpFromInvite(f, page, email);
    const dialog = page.locator("#join-link-dialog");
    const resend = dialog.getByRole("button", { name: "Send a new code" });
    await resend.waitFor({ state: "visible" });
    const reply = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/email/verify/resend");
    await resend.click();
    assert.equal((await reply).status(), 200);
    await dialog.getByText(/new code is on its way/i).waitFor({ state: "visible" });
    const mails = f.verifyMails(email);
    assert.equal(mails.length, 2, "signup mail plus the resent one");
    const link = mails.at(-1).link;
    assert.ok(link.endsWith(`#join/${f.links.valid}`), "the resent link carries the invitation");
    const fresh = await f.open(size);
    await fresh.goto(link);
    await fresh.locator("#join-link-dialog").waitFor({ state: "visible" });
  });
}

test("a typed-in empty name gets a visible message, not only a browser bubble", { timeout: 60000 }, async t => {
  const f = await setup(t);
  const page = await f.open(SIZES[1][1]);
  await signUpFromInvite(f, page, "blank-name@example.invalid");
  const dialog = page.locator("#join-link-dialog");
  await dialog.getByRole("button", { name: "Join room" }).waitFor({ state: "visible" });
  await page.locator("#join-link-name").fill("");
  await dialog.getByRole("button", { name: "Join room" }).click();
  await dialog.getByText("Enter the name to show in this room.").waitFor({ state: "visible" });
});
