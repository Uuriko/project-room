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
import { ROOM_ACCESS_NOTICE } from "../src/room-deep-link.js";

async function dismissSetup(page) {
  const later = page.locator("#account-setup-dialog").getByRole("button", { name: "Set up later" });
  try {
    await later.waitFor({ state: "visible", timeout: 4000 });
    await later.click();
  } catch { /* The setup dialog is not on this screen. */ }
}

test("sign-out clears the email form, sign-in returns to the last room, and the composer uploads a file", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-auth-return-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
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
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  const email = `return-${Date.now()}@example.invalid`;
  const password = "fixture-password-return-1";

  await page.goto(origin + "/");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#google-signin").isVisible(), true);
  assert.equal(await page.locator("#email-auth-panel").isVisible(), false);
  assert.equal(await page.locator("#email-signin").isVisible(), true);
  assert.equal(await page.locator("#signin-extra").isVisible(), false);
  assert.equal(await page.locator("#guest-entry").evaluate(node => node.open), false);

  // A pending alternate sign-in must not let another method hide its status.
  let releaseMagic;
  const magicPending = new Promise(resolve => { releaseMagic = resolve; });
  await page.route("**/api/auth/magic/request", route => { releaseMagic(route); });
  await page.locator("#signin-more").click();
  await page.locator('[data-method="magic"]').click();
  await page.locator('[data-signin-form="magic-request"] input[name=email]').fill(email);
  await page.locator('[data-signin-form="magic-request"] button[type=submit]').click();
  const magicRoute = await magicPending;
  await page.locator("#email-signin").click();
  assert.equal(await page.locator("#signin-methods").isVisible(), true);
  assert.equal(await page.locator("#email-auth-step").isVisible(), false);
  assert.equal(await page.locator("#signin-extra").isVisible(), true);
  await magicRoute.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "unavailable", message: "Use another sign-in method." }) });
  await page.locator('#auth-signin-ui [data-signin-status]').filter({ hasText: 'Use another sign-in method.' }).waitFor();
  await page.unroute("**/api/auth/magic/request");
  await page.locator("#email-signin").click();
  assert.equal(await page.locator("#google-signin").isVisible(), false);
  assert.equal(await page.locator("#email-signin").isVisible(), false);
  await page.locator('#email-auth-panel input[name=email]').fill(email);
  await page.locator('#email-auth-panel input[name=password]').fill('discard-on-back');
  await page.locator('#email-auth-back').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'email-signin');
  await page.locator('#email-signin').click();
  assert.equal(await page.locator('#email-auth-panel input[name=email]').inputValue(), email);
  assert.equal(await page.locator('#email-auth-panel input[name=password]').inputValue(), '');
  await page.locator('#email-auth-panel [data-password-mode="signup"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.name), 'email');
  assert.match(await page.locator('#email-auth-panel').innerText(), /at least 12 characters/);
  const passwordInput = page.locator("#email-auth-panel input[name=password]");
  await passwordInput.waitFor();
  assert.equal(await passwordInput.getAttribute("autocomplete"), "new-password");
  assert.equal(await passwordInput.getAttribute("value"), null);
  await page.locator("#email-auth-panel input[name=email]").fill(email);
  await passwordInput.fill(password);
  await page.locator("#email-auth-panel button[type=submit]").click();
  await dismissSetup(page);
  await page.locator("#nav-rooms").click();
  const room = page.locator("#account-rooms-list button").first();
  await room.waitFor();
  await room.click();
  await page.locator("#main").waitFor({ state: "visible" });
  const guide = page.locator("#room-guide-dismiss");
  if (await guide.isVisible()) await guide.click();

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
  const leaked = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll("input[type=password]")].map(input => ({ value: input.value, attr: input.getAttribute("value") })),
    stored: [...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index)).filter(key => /password/i.test(key ?? ""))
  }));
  assert.deepEqual(leaked.stored, []);
  for (const input of leaked.inputs) {
    assert.equal(input.value, "");
    assert.equal(input.attr, null);
  }

  await page.goto(origin + "/");
  await page.locator("#email-signin").click();
  const signInPassword = page.locator("#email-auth-panel input[name=password]");
  await signInPassword.waitFor();
  assert.equal(await signInPassword.getAttribute("autocomplete"), "current-password");
  assert.equal(await signInPassword.inputValue(), "");
  await page.locator("#email-auth-panel input[name=email]").fill(email);
  await signInPassword.fill(password);
  await page.locator("#email-auth-panel button[type=submit]").click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#inbox-panel").isVisible(), false);

  await page.locator("#session-menu-button").click();
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.goto(origin + "/?room=stranger-room");
  await page.locator("#email-signin").click();
  await page.locator("#email-auth-panel input[name=email]").fill(email);
  await page.locator("#email-auth-panel input[name=password]").fill(password);
  await page.locator("#email-auth-panel button[type=submit]").click();
  await page.locator("#account-status").waitFor({ state: "visible" });
  assert.equal(await page.locator("#account-status").innerText(), ROOM_ACCESS_NOTICE);
  assert.equal(await page.locator("#main").isVisible(), false);
  assert.deepEqual(errors, []);
});
