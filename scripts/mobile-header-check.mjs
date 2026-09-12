// Automated usability checks with synthetic identities, not human participant research.
// C1: the mobile header stays one short row; infrequent session actions live in an
// accessible menu; identity and connection state are never hidden (no access loss).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
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

async function signIn(fixture, page, origin) {
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.getByLabel("Room key", { exact: true }).fill(fixture.keys.owner);
  await page.getByLabel("Room key", { exact: true }).press("Enter");
  await page.locator("#main").waitFor({ state: "visible" });
}

test("mobile header: session actions fold into an accessible menu, conversation stays close", { timeout: 60000 }, async t => {
  const { fixture, page, errors, origin } = await setup(t, { width: 390, height: 844 });
  await signIn(fixture, page, origin);
  assert.equal(await page.locator("#session-menu-button").isVisible(), true, "menu affordance present on mobile");
  assert.equal(await page.locator("#signout-button").isVisible(), false, "sign out folded into the closed menu");
  assert.equal(await page.locator("#identity-label").isVisible(), true, "identity stays visible - no hidden access state");
  assert.equal(await page.locator("#refresh-button").isVisible(), true, "refresh stays one tap away");
  const titleBox = await page.locator("#conversation-title").boundingBox();
  assert.ok(titleBox && titleBox.y < 844, `conversation is reachable in the first viewport (y=${titleBox && titleBox.y})`);
  await page.locator("#session-menu-button").click();
  assert.equal(await page.locator("#signout-button").isVisible(), true, "menu opens to reveal session actions");
  assert.equal(await page.locator("#session-menu-button").getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#signout-button").isVisible(), false, "Escape closes the menu");
  assert.equal(await page.evaluate(() => document.activeElement.id), "session-menu-button", "Escape returns focus to the menu button");
  await page.locator("#session-menu-button").click();
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("desktop header: session actions stay inline, menu affordance hidden", { timeout: 60000 }, async t => {
  const { fixture, page, errors, origin } = await setup(t, { width: 1280, height: 900 });
  await signIn(fixture, page, origin);
  assert.equal(await page.locator("#session-menu-button").isVisible(), false, "no menu chrome on desktop");
  assert.equal(await page.locator("#signout-button").isVisible(), true, "sign out stays inline on desktop");
  await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});
