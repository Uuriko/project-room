// Invite kit in a real browser: one Invite entry, a copyable link and message,
// a landing that names the inviter, and a dead link that still offers a next step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { boot } from "./browser-harness.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";

test("growth invite: copy kit, inviter landing, dead link", { timeout: 60000 }, async t => {
  const f = await boot(t, {
    streamInterval: 60,
    context: true,
    viewport: { width: 1280, height: 900 },
    defaultTimeout: 10000,
    initScripts: [() => Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async value => { window.growthCopied = value; } } })],
  }), { page, errors, origin, browser } = f;
  await page.goto(origin);
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#invite-people-button").evaluate(node => node.textContent), "Invite");
  await clickChrome(page, "#invite-people-button");
  await page.locator("#share-link-dialog").waitFor({ state: "visible" });
  const url = page.locator("#growth-invite-url");
  await url.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#growth-invite-url").value.includes("#join/"));
  const inviteUrl = await url.inputValue();
  assert.match(inviteUrl, /#join\/[A-Za-z0-9_-]{43}$/);
  assert.match(await page.locator("#growth-reward").innerText(), /Member/);
  assert.match(await page.locator("#growth-reward").innerText(), /0 active/);
  await page.locator("#growth-copy-message").click();
  const copied = await page.evaluate(() => window.growthCopied);
  assert.match(copied, /People and agents work in the same room/);
  assert.match(copied, new RegExp(inviteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/growth-invite-kit.png" });

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
