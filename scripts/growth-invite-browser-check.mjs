// Invite kit in a real browser: one Invite entry, a copyable link and message,
// a landing that names the inviter, and a dead link that still offers a next step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome, enableHumanAdvanced } from "./room-chrome.mjs";

test("growth invite: copy kit, inviter landing, dead link", { timeout: 60000 }, async t => {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async value => {
      if (window.copyMode === "reject") throw new Error("Clipboard denied");
      if (window.copyMode === "hold") return new Promise(resolve => { window.releaseCopy = resolve; });
      window.growthCopied = value;
    } } }));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, fixture.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#invite-people-button").evaluate(node => node.textContent), "Invite");
  await page.locator("#invite-navigation > summary").click();
  await page.locator("#share-link-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#share-link-form").isVisible(), false, "human sharing avoids a second competing create-link flow");
  assert.equal(await page.locator("#growth-agent-code").isVisible(), false, "agent enrollment stays out of simple friend sharing");
  assert.equal(await page.locator("#growth-reward").isVisible(), false, "credit accounting stays out of simple friend sharing");
  const url = page.locator("#growth-invite-url");
  await url.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#growth-invite-url").value.includes("#join/"));
  let inviteUrl = await url.inputValue();
  assert.match(inviteUrl, /#join\/[A-Za-z0-9_-]{43}$/);
  assert.match(await page.locator("#growth-reward").innerText(), /Member/);
  assert.match(await page.locator("#growth-reward").innerText(), /0 active/);
  await page.locator("#growth-copy-message").click();
  assert.equal(await page.locator("#growth-kit-status").isVisible(), true, "copy confirmation must be visible, not just DOM text");
  const copied = await page.evaluate(() => window.growthCopied);
  assert.match(copied, /People and agents work in the same room/);
  assert.match(copied, new RegExp(inviteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Clipboard denial must leave the exact link selected for immediate manual copy.
  await page.evaluate(() => { window.copyMode = "reject"; });
  await page.locator("#growth-copy-link").click();
  await page.waitForFunction(() => {
    const input = document.querySelector("#growth-invite-url");
    return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  }, null, { timeout: 3000 });
  assert.match(await page.locator("#growth-kit-status").innerText(), /copy/i);
  // A platform promise can hang: still offer manual copy, without extra clicks.
  await page.evaluate(() => { window.copyMode = "hold"; });
  await page.locator("#growth-copy-message").click();
  await page.waitForFunction(() => {
    const input = document.querySelector("#growth-invite-message");
    return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  }, null, { timeout: 3000 });
  await page.evaluate(() => { window.copyMode = "ok"; });
  await page.locator("#growth-copy-link").click();
  await page.waitForFunction(() => document.querySelector("#growth-kit-status").textContent === "Link copied.");
  await page.evaluate(() => window.releaseCopy());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator("#growth-kit-status").innerText(), "Link copied.", "an older clipboard completion cannot replace newer feedback");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/growth-invite-kit.png" });

  await page.locator("#share-link-close").click();
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#invite-navigation > summary")), true, "closing returns keyboard focus to the visible Invite entry");
  assert.equal(await page.locator("#invite-people-button").isVisible(), false, "simple humans see one Invite entry even if the disclosure was previously open");
  // Retired dialog responses must not restore an older ready-to-copy invitation.
  let releaseKit, startedKit, held = false;
  const heldKit = new Promise(resolve => { releaseKit = resolve; });
  const kitStarted = new Promise(resolve => { startedKit = resolve; });
  t.after(() => releaseKit());
  await page.route("**/referrals", async route => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch(); startedKit(); await heldKit;
    await route.fulfill({ response });
  });
  await page.locator("#invite-navigation > summary").click(); await kitStarted;
  assert.equal(await url.inputValue(), "", "an opening awaiting its own read cannot offer the prior invitation");
  assert.equal(await page.locator("#growth-copy-link").isDisabled(), true);
  const previous = fixture.store.shareLinks.personalInvite(fixture.store.authenticate(fixture.keys.owner, "commons"), "commons", 10);
  fixture.store.shareLinks.cancel(fixture.keys.owner, "commons", previous.link.id, null);
  await page.locator("#share-link-close").click();
  await page.locator("#invite-navigation > summary").click();
  await page.waitForFunction(previousUrl => {
    const value = document.querySelector("#growth-invite-url").value;
    return value.includes("#join/") && value !== previousUrl;
  }, inviteUrl);
  inviteUrl = await url.inputValue();
  const oldKit = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/referrals"));
  releaseKit(); await oldKit;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await url.inputValue(), inviteUrl, "an old read cannot replace the newer dialog's link");
  await page.unroute("**/referrals");
  await page.locator("#share-link-close").click();
  await enableHumanAdvanced(page);
  await clickChrome(page, "#invite-people-button");
  assert.equal(await page.locator("#share-link-form").isVisible(), true, "Advanced retains administrative link creation");
  assert.equal(await page.locator("#growth-agent-code").isVisible(), true, "Advanced retains one-time agent enrollment");
  await page.locator("#share-link-close").click();

  const guest = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const landing = await guest.newPage();
  landing.setDefaultTimeout(10000);
  landing.on("pageerror", error => errors.push(error.message));
  await landing.goto(inviteUrl);
  await landing.locator("#join-link-dialog").waitFor({ state: "visible" });
  await landing.locator("#join-inviter-line").waitFor({ state: "visible" });
  assert.match(await landing.locator("#join-inviter-line").innerText(), /invited you\./);
  await landing.screenshot({ path: "test-results/growth-invite-landing.png" });
  await guest.close();

  const deadContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const dead = await deadContext.newPage();
  dead.setDefaultTimeout(10000);
  dead.on("pageerror", error => errors.push(error.message));
  await dead.goto(`${origin}/#join/${"a".repeat(43)}`);
  await dead.locator("#join-link-dialog").waitFor({ state: "visible" });
  await dead.waitForFunction(() => document.querySelector("#join-link-title").textContent === "This invite has ended");
  assert.match(await dead.locator("#join-link-scope").innerText(), /fresh link/);
  assert.match(await dead.locator("#join-link-status").innerText(), /Sign in and request access/);
  assert.equal(await dead.locator("#join-account-choices").isVisible(), true);
  await dead.screenshot({ path: "test-results/growth-invite-dead.png" });
  await deadContext.close();
  assert.deepEqual(errors, []);
});
