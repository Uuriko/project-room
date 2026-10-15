// Mobile sign-in history is a real navigation boundary: Back must leave the
// email step, Forward must restore it, and pending writes must stay visible.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

test("mobile email taps and browser Back/Forward retain the room and fence a pending sign-in link", { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-mobile-history-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const sent = [];
  const server = createRoomServer({ store, magicLinkMailer: createMagicLinkMailer({ send: async payload => sent.push(payload) }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const resources = { browser: null };
  t.after(async () => {
    await resources.browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const browser = resources.browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const destination = `${origin}/?room=commons`;
  await page.goto(destination);
  const passwordForm = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await passwordForm.waitFor({ state: "visible" });
  assert.equal(await page.locator("#email-signin").count(), 0);
  await page.evaluate(() => { window.historyEvents = 0; addEventListener("popstate", () => { window.historyEvents++; }); });
  await page.locator("[data-forgot-password]").tap();
  await page.locator('[data-signin-form="reset-request"]').waitFor({ state: "visible" });
  assert.equal(page.url(), destination);
  await page.evaluate(() => history.back());
  if (await page.locator('[data-password-mode="login"]').isVisible()) await page.locator('[data-password-mode="login"]').tap();
  await passwordForm.waitFor({ state: "visible" });
  assert.equal(await passwordForm.locator('[name="email"]').evaluate(element => element === document.activeElement), true);
  assert.equal(page.url(), destination, "browser Back stays on the intended sign-in page");
  await page.evaluate(() => history.forward());
  await page.locator('[data-signin-form="reset-request"]').waitFor({ state: "visible" });
  await page.locator('[data-signin-form="reset-request"] [name="email"]').fill('mobile-navigation@example.invalid');
  await page.locator('[data-email-method="magic"]').tap();
  // #3341: the recovery option lands on the one merged form (there is
  // no separate magic-request view, and the root form has no Back
  // button — the touch-target guard moves to the email field itself).
  const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
  await form.waitFor({ state: "visible" });
  const emailBox = await form.locator('[name="email"]').boundingBox();
  assert.ok(emailBox.height >= 44, "email field has a usable touch target");
  assert.equal(await form.locator('[name="email"]').inputValue(), "mobile-navigation@example.invalid", "switching recovery methods keeps the edited email");
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await page.route("**/api/auth/magic/request", route => { requests++; release(route); });
  await form.locator('button[type="submit"]').tap();
  const route = await held;
  const priorEvents = await page.evaluate(() => window.historyEvents);
  await page.evaluate(() => history.back());
  // Arriving at the merged form from recovery records no history
  // entry (password views are the unrecorded base), so the current
  // entry still names the recovery view; what matters is that Back
  // fired and was undone (+2 popstates) with the form still up.
  await page.waitForFunction(count => window.historyEvents >= count + 2 && history.state?.roomSigninView === "reset-request", priorEvents);
  assert.equal(await form.isVisible(), true, "pending email request remains visible after Back is undone");
  assert.equal(page.url(), destination);
  assert.equal(requests, 1, "navigation does not replay the pending request");
  await route.continue();
  await page.locator("#auth-signin-ui").getByText(/Check .* for your sign-in link/).waitFor();
  assert.equal(sent.length, 1, "one real request reaches the configured mail seam");
  // Post-sent Back walks the recorded entries: the sent view's entry
  // replaced the recovery entry with the merged form's, so the first
  // Back lands on the merged form — which, as the root form, has no
  // Back button of its own; the next step back is the browser's.
  await page.locator("[data-signin-back]").tap();
  await passwordForm.waitFor({ state: "visible" });
  await page.evaluate(() => history.back());
  await passwordForm.waitFor({ state: "visible" });
  assert.equal(page.url(), destination);
  await page.locator("[data-forgot-password]").tap();
  await page.reload();
  await passwordForm.waitFor({ state: "visible" });
  await page.locator("[data-forgot-password]").tap();
  await page.locator("[data-signin-back]").tap();
  await passwordForm.waitFor({ state: "visible" });
  assert.equal(page.url(), destination, "Back after reload leaves recovery in one tap");
  assert.deepEqual(errors, []);
});
