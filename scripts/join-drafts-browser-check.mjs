// door-join pack: on /join, focus stays where the browser left it, typed
// fields survive a reload, the room client loads only when a request is
// sent, and a bad code still returns focus to the entry field.
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

test("Join page: no focus grab, refresh-proof drafts, lazy room client", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-join-drafts-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams?.(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const scripts = [];
  page.on("request", request => { if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname); });

  await page.goto(`${origin}/join`);
  await page.locator("#join-enter").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "no field is focused on load");
  assert.equal(scripts.some(path => path.endsWith("/src/client.js")), false, "the room client is not loaded with the page");

  // Fill the entry code and the request form, then reload.
  await page.fill("#join-enter-code", "RM-DRAFT1");
  await page.locator("#join-request > summary").click();
  await page.fill("#join-request-name", "Ada Draft");
  await page.fill("#join-request-note", "A note that must survive a reload.");
  await page.fill("#join-request-referred", "Grace");
  await page.reload();
  await page.locator("#join-enter").waitFor({ state: "visible" });
  assert.equal(await page.inputValue("#join-enter-code"), "RM-DRAFT1");
  assert.equal(await page.inputValue("#join-request-name"), "Ada Draft");
  assert.equal(await page.inputValue("#join-request-note"), "A note that must survive a reload.");
  assert.equal(await page.inputValue("#join-request-referred"), "Grace");
  assert.equal(await page.evaluate(() => document.querySelector("#join-request").open), true, "the request form reopens");

  // A bad code still puts focus back in the entry field.
  await page.fill("#join-enter-code", "not a code");
  await page.click("#join-enter-submit");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "join-enter-code");

  // Sending the request loads the room client only now.
  scripts.length = 0;
  await page.click("#join-request-submit");
  await page.waitForFunction(() => document.querySelector("#join-request-status")?.textContent.trim().length > 0);
  assert.equal(scripts.some(path => path.endsWith("/src/client.js")), true, "the room client loads on submit");

  // A room address does not claim the room exists.
  await page.goto(`${origin}/rooms/never-existed-room`);
  await page.locator("#join-enter").waitFor({ state: "visible" });
  const roomLine = await page.locator("#join-enter-room-text").innerText();
  assert.match(roomLine, /You followed a link to "never-existed-room"/);
  assert.doesNotMatch(roomLine, /^Room "/);
  assert.deepEqual(errors, []);
});
