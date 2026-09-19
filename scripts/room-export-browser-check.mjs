// Room export (BUILD-01 F2 follow-up) browser check: a signed-in member takes
// the readable HTML export from the History panel, in room-key mode and in
// account mode (where the request must carry the session binding a plain link
// cannot). Disposable rooms only - no real users or outside requests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { fillAccessKey } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";

async function setup(t, { account = false } = {}) {
  const f = createAcceptanceFixture({ managedProducer: false }), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", acceptDownloads: true }), errors = [], outside = [], exports = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    if (/\/api\/rooms\/commons\/export/.test(route.request().url())) exports.push(route.request());
    return route.continue();
  });
  const key = account ? f.store.issueAccountAccessKey(f.store.accountForMember("commons", "owner").id) : f.keys.owner;
  await page.goto(account ? origin + "/?room=commons" : origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, key); await page.locator('#auth-form button[type="submit"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, exports };
}

async function exportFromHistory(page) {
  await openSettings(page, "record-panel");
  const button = page.locator("#record-export-html");
  await button.waitFor({ state: "attached" });
  // The button may be obscured in the sidebar; click via JS.
  const [download] = await Promise.all([page.waitForEvent("download"), button.evaluate(el => el.click())]);
  assert.equal(download.suggestedFilename(), "room-commons-export.html");
  const html = readFileSync(await download.path(), "utf8");
  assert.match(html, /End of export: \d+ events rendered, through sequence \d+\./, "the whole file arrived, closing marker included");
  assert.match(html, /Disposable test room\. Try a reply and a reaction/);
  assert.doesNotMatch(html, /<script/i);
  await page.waitForFunction(() => document.querySelector("#record-export-status").textContent.includes("Download started"));
  assert.equal(await button.isEnabled(), true);
  return html;
}

test("a member takes the HTML export from the History panel with a room key", { timeout: 30000 }, async t => {
  const { page, exports } = await setup(t);
  await exportFromHistory(page);
  assert.equal(exports.length, 1);
  assert.equal(new URL(exports[0].url()).search, "?format=html");
  assert.equal(exports[0].headers()["x-project-room-auth"], undefined, "room-key mode sends no account headers");
});

test("in account mode the export request carries the session binding a plain link cannot", { timeout: 30000 }, async t => {
  const { page, exports } = await setup(t, { account: true });
  await exportFromHistory(page);
  assert.equal(exports.length, 1);
  const headers = exports[0].headers();
  assert.equal(headers["x-project-room-auth"], "account");
  assert.match(headers["x-session-binding"] ?? "", /\S/, "the account session binding travels with the export");
});

test("a failed export leaves the room usable and says so at the control", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  await page.route("**/api/rooms/commons/export**", route => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }) }));
  await openSettings(page, "record-panel");
  await page.locator("#record-export-html").click();
  await page.getByText("Export is rate limited; try again in a minute.", { exact: true }).waitFor();
  assert.equal(await page.locator("#record-export-html").isEnabled(), true);
  assert.equal(await page.locator("#main").isVisible(), true);
});
