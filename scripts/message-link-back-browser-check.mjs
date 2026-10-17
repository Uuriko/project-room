// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
// Opening a message link (here a search result in another channel) adds a
// history entry, so Back returns to the channel and scroll position the person
// left instead of leaving the app.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { openSearch } from "./room-chrome.mjs";

test("Back after opening a message link returns to where the person was", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-link-back-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
  send(T.CHANNEL_CREATED, { channelId: "design", name: "design" });
  // Few, tall messages: the chat-flood limit caps one author's burst.
  for (let index = 1; index <= 8; index++) send(T.MESSAGE_POSTED, { messageId: `general-${index}`, body: `General note ${index}\n\n${"words ".repeat(60)}\n\n${"more ".repeat(60)}` });
  send(T.MESSAGE_POSTED, { messageId: "design-target", body: "the design needle", channelId: "design" });
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#conversation-title")?.textContent === "# general");

  // Scroll #general up a little so the restore has a position to return to.
  const list = page.locator("#message-list");
  await list.evaluate(el => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 600); });
  const before = await list.evaluate(el => el.scrollTop);
  const urlBefore = page.url();

  await openSearch(page);
  await page.locator("#message-search").fill("needle");
  await page.locator('#search-results [data-open-message="design-target"]').click();
  await page.waitForFunction(() => document.querySelector("#conversation-title")?.textContent === "# design");
  assert.match(page.url(), /#pr-record\/message\/design-target/);

  await page.goBack();
  await page.waitForFunction(() => document.querySelector("#conversation-title")?.textContent === "# general");
  assert.equal(page.url(), urlBefore, "Back returns to the previous address, still in the app");
  await page.waitForFunction(expected => Math.abs(document.querySelector("#message-list").scrollTop - expected) < 40, before);
  assert.equal(await page.locator("#main").isVisible(), true);
  assert.deepEqual(errors, []);
});
