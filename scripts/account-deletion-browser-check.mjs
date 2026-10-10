// QA2 finding P2-11: Settings → Sign-in & security → Advanced offers
// Delete account. The dialog shows the plan, requires the account email,
// and posts the confirmation token with the session CSRF header.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { ACCOUNT_DELETED_MESSAGE } from "../src/account-settings-ui.js";

const EMAIL = "delete-me@example.invalid";

async function setup(t) {
  const f = createAcceptanceFixture();
  const accountId = "delete-browser";
  f.store.createAccount(accountId, "delete-browser");
  f.store.completeOnboarding(accountId);
  f.store.accountLogins.linkPasswordMethod(accountId, { email: EMAIL, verifier: "fixture-verifier" });
  const key = f.store.issueAccountAccessKey(accountId);
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  f.store.createAccountRoom(slot.token, session.sessionBinding, {
    roomId: "delete-browser-room", title: "Solo notes", purpose: "Personal notes", kind: "personal", displayName: "Deleter"
  });
  const browserKey = f.store.issueAccountAccessKey(accountId);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  const errors = [], outside = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { page, origin, browserKey };
}

test("Delete account requires the email, posts with CSRF, and confirms on the landing page", { timeout: 60000 }, async t => {
  const { page, origin, browserKey } = await setup(t);
  await page.goto(origin + "/?account=1");
  await signInFixture(page, browserKey);
  await page.locator("#inbox-panel").waitFor();

  await clickChrome(page, "#account-settings-button");
  const opener = page.locator("#account-settings-body [data-action='delete-account']");
  await opener.waitFor();
  await opener.click();
  const dialog = page.locator("[data-deletion-dialog]");
  await dialog.waitFor({ state: "visible" });
  const email = dialog.locator('input[name="confirmEmail"]');
  await email.waitFor();
  // Plain summary first; the engineering inventory sits behind "Full deletion plan".
  await dialog.getByText(/permanently deletes your account/).waitFor();
  await dialog.getByText(/archived, and their messages and files permanently deleted: .*Solo notes/).waitFor();
  assert.equal(await dialog.getByText(/Retention categories purged/).isVisible(), false);
  assert.equal(await dialog.getByText(/categories purged \(/).isVisible(), false);
  // Keyboard only (Jill - Dot, #2414): Shift+Tab from the email lands on the
  // disclosure, Enter opens it, Space closes it, and Tab from the last control
  // wraps back to it inside the dialog.
  const disclosure = dialog.locator("summary", { hasText: "Full deletion plan" });
  const focusedIsDisclosure = () => disclosure.evaluate(node => node === document.activeElement);
  await email.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focusedIsDisclosure(), true, "Shift+Tab from the email reaches Full deletion plan");
  await page.keyboard.press("Enter");
  await dialog.getByText(/Retention categories purged/).waitFor();
  await page.keyboard.press("Space");
  await dialog.getByText(/Retention categories purged/).waitFor({ state: "hidden" });
  await page.keyboard.press("Enter");
  await dialog.getByText(/Retention categories purged/).waitFor();
  const pre = dialog.locator("[data-deletion-summary] pre");
  assert.equal(await pre.evaluate(node => getComputedStyle(node).whiteSpace), "pre-wrap", "the expanded plan wraps on a phone");
  assert.ok(await pre.evaluate(node => node.scrollWidth <= node.clientWidth + 1), "no sideways scroll in the plan at this width");
  await dialog.locator("[data-action='delete-account-cancel']").focus();
  await page.keyboard.press("Tab");
  assert.equal(await focusedIsDisclosure(), true, "Tab from Cancel wraps to Full deletion plan");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 1280, height: 900 });
  await opener.click();
  await dialog.waitFor({ state: "visible" });
  const submit = dialog.locator('form[data-form="delete-account"] button[type="submit"]');
  let posted = 0;
  page.on("request", request => {
    if (request.method() === "POST" && request.url().endsWith("/api/account/delete")) posted += 1;
  });
  await email.fill("someone-else@example.invalid");
  assert.equal(await submit.isDisabled(), true);
  await email.press("Enter");
  assert.equal(posted, 0);

  await email.fill(EMAIL);
  assert.equal(await submit.isDisabled(), false);
  const requestPromise = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/account/delete"));
  await submit.click();
  const request = await requestPromise;
  assert.equal(typeof request.headers()["x-csrf-token"], "string");
  assert.ok(request.headers()["x-csrf-token"].length > 0);
  await page.locator("#auth-error").getByText(ACCOUNT_DELETED_MESSAGE).waitFor();
  assert.equal(await page.locator("#auth-panel").isVisible(), true);
});
