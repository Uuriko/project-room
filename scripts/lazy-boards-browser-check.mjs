import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { fillAccessKey } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";

// Authoring gate: real-browser transport/lifecycle contract. Eager loading
// wastes entry requests; a late import after sign-out must not read room data.
// Existing board unit tests cover rendering, not either browser boundary.
// No production test hooks or API doubles.
async function setup(t) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const requests = [], errors = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const enter = async () => {
    await page.goto(origin);
    await fillAccessKey(page, fixture.keys.owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
  };
  return { page, requests, enter };
}

test("secondary boards load on disclosure, once, without delaying ordinary chat", { timeout: 30000 }, async t => {
  const { page, requests, enter } = await setup(t);
  await enter();
  await page.locator("#message-input").fill("Chat is ready before secondary boards");
  assert.equal(requests.some(path => /(?:referral-board|land-queue-board)\.js$|\/list_land_queue$|\/referrals$/.test(path)), false);
  for (const [panel, endpoint, counter] of [
    ["land-queue", "/list_land_queue", "land-queue-count"],
    ["referral", "/referrals", "referral-count"]
  ]) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(endpoint) && r.ok());
    await page.locator(`#${panel}-panel > summary`).click();
    await response;
    await page.waitForFunction(id => document.getElementById(id).textContent !== "", counter);
    assert.equal(requests.filter(path => path.endsWith(`/${panel}-board.js`)).length, 1);
    const count = requests.filter(path => path.endsWith(endpoint)).length;
    await page.locator(`#${panel}-panel > summary`).click();
    await page.locator(`#${panel}-panel > summary`).click();
    assert.equal(requests.filter(path => path.endsWith(endpoint)).length, count);
  }
  assert.equal(await page.locator("#message-input").inputValue(), "Chat is ready before secondary boards");
});

test("sign-out cancels activation of a delayed secondary-board import", { timeout: 30000 }, async t => {
  const { page, requests, enter } = await setup(t);
  let release, requested;
  const held = new Promise(resolve => { requested = resolve; });
  await page.route("**/land-queue-board.js", async route => {
    await new Promise(resolve => { release = resolve; requested(); });
    await route.continue();
  });
  await enter();
  await page.locator("#land-queue-panel > summary").click();
  await held;
  await clickChrome(page, "#signout-button");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  const finished = page.waitForResponse(r => r.url().endsWith("/land-queue-board.js"));
  release(); await finished;
  // Await module evaluation, then the promise continuations that own activation.
  await page.evaluate(async () => { await import("/src/land-queue-board.js"); });
  assert.equal(await page.locator("#land-queue-panel").evaluate(panel => panel.open), false);
  assert.equal(requests.some(path => path.endsWith("/list_land_queue")), false);
});

test("late referral data cannot repaint a signed-out workspace", { timeout: 30000 }, async t => {
  const { page, enter } = await setup(t);
  let release, requested;
  const held = new Promise(resolve => { requested = resolve; });
  await page.route("**/referrals", async route => {
    const response = await route.fetch();
    await new Promise(resolve => { release = resolve; requested(); });
    await route.fulfill({ response });
  });
  await enter();
  await page.locator("#referral-panel > summary").click();
  await held;
  await clickChrome(page, "#signout-button");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  // A visible sentinel makes even an empty stale response's repaint observable.
  await page.locator("#referral-count").evaluate(node => { node.textContent = "cleared"; });
  const finished = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/referrals"));
  release(); await finished;
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator("#referral-count").textContent(), "cleared");
  assert.equal(await page.locator("#referral-panel").evaluate(panel => panel.open), false);
});
