// Phone menu drawer: the room behind it is dimmed, and tapping the dimmed
// area closes the drawer.
// Real browser + local HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { signInFixture } from "./auth-signin.mjs";

test("Phone menu drawer dims the room and closes on a tap outside", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-drawer-scrim-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });

  const scrim = () => page.evaluate(() => {
    const style = getComputedStyle(document.querySelector("#main"), "::after");
    return { content: style.content, background: style.backgroundColor, position: style.position };
  });
  assert.equal((await scrim()).content, "none", "no scrim while the drawer is closed");
  await page.locator("#sidebar-toggle").click();
  await page.locator("#room-sidebar").waitFor({ state: "visible" });
  const open = await scrim();
  assert.equal(open.position, "fixed", "scrim covers the viewport");
  assert.match(open.background, /rgba\(0, 0, 0, 0\.[1-9]/, "scrim dims the room");
  const sidebar = await page.locator("#room-sidebar").boundingBox();
  await page.mouse.click(sidebar.x + sidebar.width + 20, 400);
  await page.locator("#room-sidebar").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#sidebar-toggle").getAttribute("aria-expanded"), "false");
  assert.equal((await scrim()).content, "none", "scrim goes away with the drawer");

  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await desk.goto(origin);
  await desk.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(desk, owner);
  await desk.locator("#main").waitFor({ state: "visible" });
  await desk.evaluate(() => document.querySelector("#main").classList.add("sidebar-open"));
  assert.equal(await desk.evaluate(() => getComputedStyle(document.querySelector("#main"), "::after").content), "none", "no scrim on desktop");
  assert.deepEqual(errors, []);
});
