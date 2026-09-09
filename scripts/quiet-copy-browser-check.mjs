// Automated usability checks with synthetic identities, not human participant research.
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

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["narrow", { width: 320, height: 780 }]]) {
  test(`quiet copy ${label}: minimal login retains help, labels, errors, keyboard and room state`, { timeout: 60000 }, async t => {
    const { fixture, page, errors, origin } = await setup(t, viewport);
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator(".connection-bar").isVisible(), false);
    assert.equal(await page.locator("#identity-label").isVisible(), false);
    assert.equal(await page.locator("#auth-error").textContent(), "");
    assert.equal(await page.getByLabel("Room key", { exact: true }).isVisible(), true);
    assert.equal(await page.locator("#auth-description").isVisible(), false);
    assert.match(await page.locator("#auth-guest-note").textContent(), /eight hours/);
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#connection-status").dataset.state === "signed-out");
    assert.equal(await page.locator("#auth-error").textContent(), "", "normal signed-out refresh is not an error");
    await page.locator("#skip-link").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "auth-title");
    const help = page.locator(".access-help > summary");
    await help.focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator("#auth-description").isVisible(), true);
    assert.match(await page.locator("#auth-hint").textContent(), /private.*guest access/i);
    await page.keyboard.press("Enter");
    await page.screenshot({ path: `test-results/quiet-copy-${label}-login.png` });
    await page.getByLabel("Room key", { exact: true }).fill("invalid-key");
    await page.getByLabel("Room key", { exact: true }).press("Enter");
    await page.waitForFunction(() => document.querySelector("#auth-error").textContent.includes("Check the access key"));
    assert.equal(await page.locator("#auth-error").isVisible(), true);
    assert.equal(await page.locator("#status").textContent(), "", "one authentication error region");
    await page.getByLabel("Room key", { exact: true }).fill(fixture.keys.owner);
    await page.getByLabel("Room key", { exact: true }).press("Enter");
    await page.locator("#main").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#access-key").disabled);
    assert.equal(await page.locator("#identity-label").isVisible(), true);
    assert.equal(await page.locator("#status").textContent(), "", "entering the room is its own success feedback");
    assert.equal(await page.locator(".connection-bar").isVisible(), true);
    assert.equal(await page.locator("#draft-hint").isVisible(), false);
    await page.locator("#composer-options > summary").click();
    assert.equal(await page.locator("#draft-hint").isVisible(), true);
    await page.locator("#composer-options > summary").click();
    await page.locator("#skip-link").focus(); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "connection-status");
    await page.screenshot({ path: `test-results/quiet-copy-${label}-room.png`, fullPage: true });
    await page.locator("#invite-people-button").click();
    assert.equal(await page.locator("#share-local-note").isVisible(), true);
    assert.match(await page.locator("#share-link-dialog").innerText(), /Send this link to a person/);
    await page.screenshot({ path: `test-results/quiet-copy-${label}-invite.png` });
    await page.locator("#share-link-close").click();
    await page.locator("#signout-button").click();
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await help.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: `test-results/quiet-copy-${label}-large-text.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
}

test("quiet copy: account entry is not an error, actual service failure remains visible", { timeout: 30000 }, async t => {
  const { page, errors, origin } = await setup(t, { width: 1280, height: 900 });
  await page.goto(`${origin}/?room=commons`);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-title").textContent(), "#commons");
  assert.equal(await page.locator("#auth-panel").getByLabel("Account key", { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Open room", exact: true }).isVisible(), true);
  assert.equal(await page.locator("#auth-error").textContent(), "");
  assert.equal(await page.locator(".connection-bar").isVisible(), false);
  await page.route("**/api/session", route => route.abort("failed"));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator(".connection-bar").isVisible(), true);
  assert.match(await page.locator("#auth-error").textContent(), /Can’t reach the room.*refreshing/);
  assert.equal(await page.getByRole("button", { name: "Refresh connection" }).isVisible(), true);
  await page.screenshot({ path: "test-results/quiet-copy-service-error.png" });
  assert.deepEqual(errors, []);
});
