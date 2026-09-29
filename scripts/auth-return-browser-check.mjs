import { openMagicSignin, backToPasswordSignin } from "./signin-browser-journey.mjs";
// Welcome, sign-out, and return-to-room checks for a new human account.
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
import { ROOM_ACCESS_NOTICE } from "../src/room-deep-link.js";

async function dismissSetup(page) {
  const later = page.locator("#account-setup-dialog").getByRole("button", { name: "Set up later" });
  try {
    await later.waitFor({ state: "visible", timeout: 4000 });
    await later.click();
  } catch { /* The setup dialog is not on this screen. */ }
}

test("email link sign-in returns to the last room, pending entry is guarded, and the composer uploads a file", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-auth-return-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const sent = [];
  const magicLinkMailer = { isConfigured: () => true, sendMagicLink: payload => configuredMailer.sendMagicLink(payload) };
  const server = createRoomServer({ store, streamInterval: 40, magicLinkMailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configuredMailer = createMagicLinkMailer({ baseUrl: origin, send: async payload => sent.push(payload) });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || error.message));
  page.on("dialog", dialog => dialog.accept());
  const email = `return-${Date.now()}@example.invalid`;
  const form = () => page.locator('#auth-signin-ui [data-signin-form="magic-request"]');
  const redeemDeliveredLink = async () => {
    await page.locator("#email-auth-panel").getByText(/Check .* for your sign-in link/).waitFor();
    const delivery = sent.at(-1);
    assert.equal(delivery.to, email);
    assert.equal(typeof delivery.link, "string", "mailer exposes the actual sign-in link");
    await page.goto(delivery.link);
  };
  const requestAndRedeem = async () => {
    await openMagicSignin(page);
    await form().locator('[name=email]').fill(email);
    await form().locator('button[type=submit]').click();
    await redeemDeliveredLink();
  };
  await page.goto(origin + "/");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#google-signin").isVisible(), true);
  assert.equal(await page.locator("#email-auth-panel").isVisible(), false);
  assert.equal(await page.locator('#auth-signin-ui [data-signin-form="password"]').isVisible(), true);

  let releaseMagic;
  const magicPending = new Promise(resolve => { releaseMagic = resolve; });
  await page.route("**/api/auth/magic/request", route => { releaseMagic(route); });
  await openMagicSignin(page);
  await form().locator('[name=email]').fill(email);
  await form().locator('button[type=submit]').click();
  const magicRoute = await magicPending;
  assert.equal(await page.locator("#auth-signin-ui [data-signin-back]").isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#email-auth-step").isVisible(), true, "pending request cannot hide its status");
  assert.equal(await page.locator("#signin-methods").isVisible(), false);
  await magicRoute.fulfill({ status: 200, json: { status: "unavailable", message: "Synthetic mail outage. Try again." } });
  await page.locator('#auth-signin-ui [data-signin-status]').filter({ hasText: 'Synthetic mail outage.' }).waitFor();
  await page.unroute("**/api/auth/magic/request");
  await backToPasswordSignin(page);
  assert.equal(await page.locator('#auth-signin-ui [name=email]').evaluate(node => node === document.activeElement), true);
  await openMagicSignin(page);
  assert.equal(await form().locator('[name=email]').inputValue(), email);
  assert.equal(await page.locator('#email-auth-panel input[type=password]').count(), 0);
  const assertCompactHeading = async () => {
    const back = await page.locator("#auth-signin-ui [data-signin-back]").boundingBox();
    assert.ok(back.width >= 44 && back.height >= 44, "Back retains a usable target");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  };
  await assertCompactHeading();
  await page.screenshot({ path: "test-results/signin-email-link.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertCompactHeading();
  assert.equal(await form().locator('button[type=submit]').isVisible(), true);
  await page.screenshot({ path: "test-results/signin-email-link-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await form().locator('button[type=submit]').click();
  await redeemDeliveredLink();
  await dismissSetup(page);
  await page.locator("#nav-rooms").click();
  const room = page.locator("#account-rooms-list button").first();
  await room.waitFor();
  await room.click();
  await page.locator("#main").waitFor({ state: "visible" });

  const upload = page.waitForResponse(response => response.request().method() === "POST" && /\/api\/rooms\/[^/]+\/files$/.test(new URL(response.url()).pathname) && response.ok());
  await page.locator("#composer-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello from the composer") });
  const uploaded = await upload;
  assert.equal(uploaded.status(), 201);
  await page.waitForFunction(() => {
    const chip = document.querySelector("#composer-attachments .file-chip");
    const text = chip?.textContent ?? "";
    return text.includes("notes.txt") && !text.includes("Uploading") && !text.includes("failed");
  });
  await page.locator("#message-input").fill("See the attached notes");
  const commit = page.waitForResponse(response => response.request().method() === "POST" && /\/files\/[^/]+\/commit$/.test(new URL(response.url()).pathname));
  await page.locator("#message-form button[type=submit]").click();
  assert.equal((await commit).ok(), true);
  await page.locator("#message-list .file-chip", { hasText: "notes.txt" }).waitFor();

  await page.locator("#session-menu-button").click();
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#email-auth-panel input[type=password]").count(), 0);
  await page.goto(origin + "/");
  await requestAndRedeem();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#inbox-panel").isVisible(), false);

  await page.locator("#session-menu-button").click();
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.goto(origin + "/?room=stranger-room");
  await requestAndRedeem();
  await page.locator("#account-status").waitFor({ state: "visible" });
  assert.equal(await page.locator("#account-status").innerText(), ROOM_ACCESS_NOTICE);
  assert.equal(await page.locator("#main").isVisible(), false);
  assert.deepEqual(errors, []);
});
