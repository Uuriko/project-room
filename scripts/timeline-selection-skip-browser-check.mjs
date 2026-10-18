// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
// An arriving message must not read the page selection when nothing in the
// timeline is selected: window.getSelection() forces a style recalc on every
// render. A real selection in the timeline is still kept across arrivals.
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

test("arrivals skip the selection read when nothing is selected, and keep a real selection", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-selection-skip-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED, data: { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] } });
  const maya = store.issueAccessKey("commons", "maya");
  store.command(owner, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "keep", body: "Select these words please" } });
  const server = createRoomServer({ store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const read = window.getSelection.bind(window);
    window.__selectionReads = 0;
    window.getSelection = () => { window.__selectionReads++; return read(); };
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator('[data-message-record-id="keep"]').waitFor();
  let next = 0;
  const arrive = async () => {
    const id = `live-${next++}`;
    store.command(maya, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: id, body: `Live ${id}` } });
    await page.locator(`[data-message-record-id="${id}"]`).waitFor();
  };

  // Nothing selected: arrivals render without reading the selection.
  await page.evaluate(() => { document.activeElement?.blur?.(); window.__selectionReads = 0; });
  for (let index = 0; index < 3; index++) await arrive();
  assert.equal(await page.evaluate(() => window.__selectionReads), 0, "no selection read per arrival when nothing is selected");

  // A real selection in the timeline is still kept across an arrival.
  await page.evaluate(() => {
    const body = document.querySelector('[data-message-record-id="keep"] .message-body');
    const range = document.createRange(); range.selectNodeContents(body);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.waitForFunction(() => window.__selectionReads > 0); // selectionchange noticed it
  await arrive();
  assert.equal(await page.evaluate(() => getSelection().toString().trim()), "Select these words please");
  assert.deepEqual(errors, []);
});
