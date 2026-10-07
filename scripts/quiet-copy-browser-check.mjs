import { openMagicSignin, backToPasswordSignin } from "./signin-browser-journey.mjs";
import { clickChrome } from "./room-chrome.mjs";
// Automated usability checks with synthetic identities, not human participant research.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t, viewport) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  page.setDefaultTimeout(8000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  return { fixture, page, errors, origin: `http://127.0.0.1:${server.address().port}` };
}

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["narrow", { width: 320, height: 780 }]]) {
  test(`quiet copy ${label}: minimal sign-in retains keyboard navigation and room state`, { timeout: 60000 }, async t => {
    const { fixture, page, errors, origin } = await setup(t, viewport);
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    // A visitor starts with account creation, login, and exactly one agent entry.
    assert.equal(await page.locator("#auth-title").textContent(), "PROJECT ROOM");
    assert.equal(await page.locator("#google-signin").isVisible(), false);
    assert.equal(await page.locator('#auth-signin-ui [data-signin-form="password"]').isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "Create account", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Log in", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "Agent sign in", exact: true }).count(), 1);
    assert.equal(await page.locator("#agent-signin-button").isVisible(), true);
    await page.screenshot({ path: `test-results/signin-${label}-welcome.png`, fullPage: true });
    await openMagicSignin(page);
    await page.locator('#auth-signin-ui [data-signin-form="magic-request"]').waitFor();
    await page.screenshot({ path: `test-results/signin-${label}-email.png`, fullPage: true });
    assert.equal(await page.locator(".connection-bar").isVisible(), false);
    assert.equal(await page.locator("#identity-label").isVisible(), false);
    assert.equal(await page.locator("#auth-error").textContent(), "");
    await backToPasswordSignin(page);
    assert.equal(await page.locator('#auth-signin-ui [name=email]').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator(".topbar").isVisible(), false, "healthy signed-out entry has no utility-only navbar");
    await page.reload();
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#connection-status").dataset.state === "signed-out");
    assert.equal(await page.locator("#auth-error").textContent(), "", "normal signed-out refresh is not an error");
    await page.locator("#skip-link").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "auth-title");
    await signInFixture(page, fixture.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });
    await page.locator("#session-menu-button").click();
    assert.equal(await page.locator("#identity-label").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#status").textContent(), "", "entering the room is its own success feedback");
    assert.equal(await page.locator(".connection-bar").isVisible(), true);
    assert.equal(await page.locator("#composer-options").evaluate(node => node.open), false, "secondary composer options start closed");
    assert.equal(await page.locator("#draft-hint").count(), 0);
    const hint = await page.locator("#message-input").getAttribute("aria-description");
    assert.match(hint, /Enter to send|Return for a new line/);
    assert.equal(await page.locator("#message-input").getAttribute("title"), hint);
    await page.locator("#skip-link").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "conversation-title");
    await page.screenshot({ path: `test-results/quiet-copy-${label}-room.png`, fullPage: true });
    await clickChrome(page, "#invite-people-button");
    await page.locator("#share-link-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("#share-link-dialog").innerText(), /Share one link with people or AI agents/);
    await page.screenshot({ path: `test-results/quiet-copy-${label}-invite.png` });
    await page.locator("#share-link-close").click();
    if (await page.locator("#session-menu-button").isVisible()) await page.locator("#session-menu-button").click(); await clickChrome(page, "#signout-button");
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
      await page.evaluate(() => JSON.stringify({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, title: { width: document.querySelector("#auth-title").clientWidth, scrollWidth: document.querySelector("#auth-title").scrollWidth, font: getComputedStyle(document.querySelector("#auth-title")).fontSize }, overflow: [...document.querySelectorAll("body *")].filter(node => { const r = node.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(node => ({ id: node.id, tag: node.tagName, width: node.getBoundingClientRect().width })) })));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
      await page.evaluate(() => JSON.stringify({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, title: { width: document.querySelector("#auth-title").clientWidth, scrollWidth: document.querySelector("#auth-title").scrollWidth, font: getComputedStyle(document.querySelector("#auth-title")).fontSize }, overflow: [...document.querySelectorAll("body *")].filter(node => { const r = node.getBoundingClientRect(); return r.width && r.right > innerWidth + 1; }).map(node => ({ id: node.id, tag: node.tagName, width: node.getBoundingClientRect().width })) })));
    await page.screenshot({ path: `test-results/quiet-copy-${label}-large-text.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
}

test("quiet copy: account entry is not an error, actual service failure remains visible", { timeout: 30000 }, async t => {
  const { page, errors, origin } = await setup(t, { width: 1280, height: 900 });
  await page.goto(`${origin}/?room=commons`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-title").textContent(), "Open room commons");
  assert.equal(await page.locator("#google-signin").isVisible(), false);

  assert.equal(await page.locator("#auth-error").textContent(), "");
  assert.equal(await page.locator(".connection-bar").isVisible(), false);
  await page.route("**/api/session", route => route.abort("failed"));
  // QAU-006: a first paint with no remembered room and no account hint does
  // not probe the session at all. An account hint alone uses /api/account-session
  // and does not GET /api/session. The failure this checks for is the room
  // probe a returning member still naming a room meets.
  await page.evaluate(() => {
    localStorage.setItem("pr-had-account", "1");
    localStorage.setItem("pr-last-room", "commons");
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator(".connection-bar").isVisible(), true);
  assert.match(await page.locator("#auth-error").textContent(), /Can’t reach the room.*refreshing/);
  assert.equal(await page.getByRole("button", { name: "Refresh connection" }).isVisible(), true);
  await page.screenshot({ path: "test-results/quiet-copy-service-error.png" });
  assert.deepEqual(errors, []);
});
