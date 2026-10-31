/* global document */
// Default room MVP: single-feature modules (reminders, device pairing, human
// push) stay off the room-entry path and load on their first trigger.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "../scripts/auth-signin.mjs";
import { openConversationWork, openCatchUp } from "../scripts/room-chrome.mjs";

const DEFERRED = ["/src/reminders.js", "/src/pairing-ui.js", "/src/human-push.js"];
const DEFERRED_READS = ["/api/rooms/commons/reminders", "/api/rooms/commons/human-push"];

async function harness(t, width = 390) {
  const f = createAcceptanceFixture(); f.store.roomFlood = { consume() {} };
  const server = createRoomServer({ store: f.store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], paths = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => paths.push(new URL(request.url()).pathname));
  await page.goto(origin); await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  return { f, page, errors, paths };
}
const count = (paths, path) => paths.filter(p => p === path).length;
async function remindButton(page) {
  const card = await openConversationWork(page, "test-handoff");
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  return card.getByRole("button", { name: "Remind me", exact: true });
}

for (const width of [390, 1280]) test(`room entry at ${width}px does not load reminders, pairing or push`, { timeout: 60000 }, async t => {
  const { page, errors, paths } = await harness(t, width);
  await page.reload(); await page.locator("#main").waitFor({ state: "visible" }); await page.waitForTimeout(1200);
  for (const path of [...DEFERRED, ...DEFERRED_READS]) assert.equal(count(paths, path), 0, `${path} stays off room entry`);
  // Review and revocation paths are still live on entry.
  assert.ok(paths.includes("/api/rooms/commons/stream"), "the live stream (revocation, review state) stays eager");
  await openCatchUp(page);
  for (let i = 0; i < 50 && !paths.includes("/api/rooms/commons/reminders"); i++) await page.waitForTimeout(100);
  assert.equal(count(paths, "/src/reminders.js"), 1);
  assert.ok(paths.includes("/api/rooms/commons/reminders"));
  assert.deepEqual(errors, []);
});

test("the first Remind me click is replayed after load; a double click opens once", { timeout: 60000 }, async t => {
  const { page, errors, paths } = await harness(t);
  const button = await remindButton(page);
  await button.dblclick();
  await page.locator("#reminder-dialog[open]").waitFor();
  await page.locator('#reminder-form[aria-busy="false"]').waitFor();
  assert.equal(count(paths, "/src/reminders.js"), 1, "one import for repeated clicks");
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 1);
  await page.keyboard.press("Escape");
  await page.locator("#reminder-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("a failed import reports once and the next click retries", { timeout: 60000 }, async t => {
  const { page, errors } = await harness(t);
  let fail = true;
  await page.route("**/src/reminders.js*", route => fail ? route.abort("failed") : route.continue());
  const button = await remindButton(page);
  await button.click();
  await page.locator("#status", { hasText: "Could not load reminders. Try again." }).waitFor();
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 0);
  assert.equal(await button.getAttribute("aria-busy"), null, "the trigger is not left busy");
  fail = false;
  await button.click();
  await page.locator("#reminder-dialog[open]").waitFor();
  assert.deepEqual(errors, []);
});

test("Escape during the load drops the replay and keeps focus on the trigger", { timeout: 60000 }, async t => {
  const { page, errors } = await harness(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/src/reminders.js*", async route => { await gate; await route.continue(); });
  const button = await remindButton(page);
  await button.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  release();
  await page.waitForFunction(() => !document.querySelector("[data-reminder-work][aria-busy]"));
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 0, "Escape cancels the held open");
  assert.equal(await button.evaluate(node => node === document.activeElement), true);
  await button.click();
  await page.locator("#reminder-dialog[open]").waitFor();
  assert.deepEqual(errors, []);
});
