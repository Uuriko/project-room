// Signed-in local journey: real HTTP graph/claim writes, then the actual Board.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { signInFixture } from "./auth-signin.mjs";

test("signed-in Board shows the graph-derived advisory from authorized HTTP claims", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.keys.owner}` }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  await post("/api/rooms/commons/map", { repo: "acme/widgets", revision: "browser-proof", files: [
    { path: "a.js", source: "export function helper() { return 1; }" },
    { path: "b.js", source: 'import { helper } from "./a.js"; export function run() { return helper(); }' }
  ] });
  const client = new RoomAgentClient({ origin, roomId: "commons", token: f.keys.owner });
  await client.workClaim("helper-owner", { repo: "acme/widgets", title: "Maintain helper", files: ["a.js"] });
  const second = await client.workClaim("helper-caller", { repo: "acme/widgets", title: "Update caller", files: ["b.js"] });
  assert.deepEqual(second.overlap.symbols, ["helper"]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#room-more > summary").click(); await page.locator("#topbar-settings").click();
  await page.locator("#advanced-room-tools > summary").click(); await page.locator("#human-advanced").check(); await page.keyboard.press("Escape");
  await page.locator("#tasks-board-open").click();
  const chip = page.locator('article[data-claim-id="helper-caller"] .overlap-chip');
  await chip.locator("summary").focus(); await page.keyboard.press("Enter");
  assert.equal(await chip.evaluate(node => node.open), true);
  assert.match(await chip.innerText(), /Maintain helper/);
  assert.match(await chip.innerText(), /helper\(\)/);
  const files = page.locator('article[data-claim-id="helper-caller"] .claim-files');
  await files.locator("summary").click();
  assert.match(await files.innerText(), /b\.js/);
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/project-map-signed-in-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/project-map-signed-in-phone.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
