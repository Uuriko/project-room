// Computed-style regression for the shared tokens and the regrouped Settings
// dialog. The repo has no pixel-snapshot library; screenshots are evidence
// and these assertions are the check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";
import { ROOM_ENTRY_HTML, publicRoomDoorHtml } from "../deploy/room-entry.mjs";

const shots = "/opt/cursor/artifacts/design";

async function boot(t) {
  mkdirSync(shots, { recursive: true });
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await browser.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { page, origin, browser, key: f.keys.owner };
}

test("shared tokens, focus, and settings sections render together", { timeout: 60000 }, async t => {
  const { page, origin, browser, key } = await boot(t);
  await page.goto(origin + "/");
  await page.locator("#auth-title").waitFor();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  assert.equal(bg, "#202127");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  assert.notEqual(outline.style, "none");
  assert.notEqual(outline.width, "0px");
  await page.screenshot({ path: `${shots}/after-auth.png`, fullPage: true });

  await signInFixture(page, key);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.screenshot({ path: `${shots}/after-room.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${shots}/after-room-mobile.png` });
  await page.setViewportSize({ width: 1280, height: 900 });

  await openSettings(page);
  const dialog = page.locator("#settings-dialog");
  for (const title of ["Room", "Agents & connections", "Billing / plan", "Advanced"]) {
    await dialog.locator(".settings-group-title", { hasText: title }).waitFor();
  }
  const resultsParent = await page.locator("#results-panel").evaluate(node => node.parentElement.id);
  assert.equal(resultsParent, "settings-dialog");
  await dialog.screenshot({ path: `${shots}/after-settings.png` });

  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  assert.equal(light, "#f4f3f8");
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  await page.goto(origin + "/about");
  await page.locator("h1").waitFor();
  const aboutBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(aboutBg, "rgb(32, 33, 39)");
  await page.screenshot({ path: `${shots}/after-about.png`, fullPage: true });

  await page.goto(origin + "/offers");
  await page.locator("body").waitFor();
  const offersBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(offersBg, "rgb(32, 33, 39)");
  await page.screenshot({ path: `${shots}/after-offers.png`, fullPage: true });

  const door = await browser.newPage();
  await door.setContent(ROOM_ENTRY_HTML, { waitUntil: "load" });
  await door.screenshot({ path: `${shots}/after-door-demigod.png`, fullPage: true });
  await door.setContent(publicRoomDoorHtml(), { waitUntil: "load" });
  const doorBg = await door.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(doorBg, "rgb(32, 33, 39)");
  await door.screenshot({ path: `${shots}/after-door-public.png`, fullPage: true });
  await door.close();
});
