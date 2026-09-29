import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

test("visible entry choices open focused flows without hiding pending agent sign-in", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    for (const selector of ["#google-signin", "#email-signin", "#guest-entry > summary", "#agent-signin-button"]) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} is immediately discoverable at ${width}px`);
    }
    await page.locator("#guest-entry > summary").click();
    await page.locator("#invite-link").waitFor({ state: "visible" });
    await page.locator("#signin-methods").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#signin-methods").isVisible(), false);
    assert.equal(await page.locator("#signin-extra").isVisible(), false);
    await page.locator("#agent-signin-button").click();
    assert.equal(await page.locator("#invite-link").isVisible(), false);
    assert.equal(await page.locator("#join-agent-prompt").isVisible(), false);
    assert.equal(await page.locator("#signin-extra").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.name), "identityId");
    let pendingRoute;
    const pending = new Promise(resolve => { pendingRoute = resolve; });
    await page.route("**/api/auth/agent/rooms", route => pendingRoute(route));
    await page.locator('[name="identityId"]').fill("ai_test");
    await page.locator('[name="secret"]').fill("invalid-test-credential");
    await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
    const route = await pending;
    await page.locator("#agent-auth-back").click();
    assert.equal(await page.locator("#agent-auth-step").isVisible(), true, "pending request stays visible");
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Test identity could not be verified." }) });
    await page.locator('[data-agent-status]').filter({ hasText: "Test identity could not be verified." }).waitFor();
    await page.locator("#agent-auth-back").click();
    assert.equal(await page.locator("#google-signin").isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "agent-signin-button");
    await page.locator("#agent-signin-button").click();
    await page.locator("[data-agent-new]").click();
    await page.locator("#agent-auth-back").click();
    await page.locator("#agent-signin-button").click();
    assert.equal(await page.evaluate(() => document.activeElement.name), "createName", "reopened create phase focuses its visible field");
    await page.locator("#agent-auth-back").click();
    await page.locator("#signin-more").click();
    assert.equal(await page.locator("#signin-extra").isVisible(), true);
    assert.equal(await page.locator("#agent-auth-step").isVisible(), false);
    assert.equal(await page.locator("#key-signin").evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.close();
  }
});

test("agent browser sign-in opens a linked room and survives reload without the secret", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const identity = f.store.identities.create("Browser test agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", { identityId: identity.identityId, permissions: ["accept_work"] });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator("#agent-signin-button").click();
  await page.locator('[name="identityId"]').fill(identity.identityId);
  await page.locator('[name="secret"]').fill(identity.secret);
  await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
  await page.locator('[data-room-id="commons"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  // First-run orientation: shows once after an agent's first browser sign-in.
  await page.locator("#agent-first-run").waitFor({ state: "visible" });
  assert.match(await page.locator("#agent-first-run").textContent(), /DMs are open by default/);
  await page.locator('#agent-first-run [data-step="dismiss"]').click();
  await page.locator("#agent-first-run").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(secret => Object.values(localStorage).concat(Object.values(sessionStorage)).some(value => value.includes(secret)), identity.secret), false);
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#agent-first-run").count(), 0, "the orientation never shows again");
  assert.deepEqual(errors, []);
});
