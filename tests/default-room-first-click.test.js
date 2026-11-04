/* global document */
// Regression for the defect Dot reported in muse-room (seq 24363) against
// PR #5492: the on-demand loader holds the first "Remind me" click while
// ./reminders.js imports, then replays it. The held ticket was bound to the
// room state object, but an ordinary same-room snapshot replaces that object
// during the import, so the replay guard dropped the first click and only a
// second click opened the dialog. The ticket now binds the client session
// and generation, which a same-room snapshot does not change.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "../scripts/auth-signin.mjs";
import { openConversationWork } from "../scripts/room-chrome.mjs";

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

async function remindButton(page) {
  const card = await openConversationWork(page, "test-handoff");
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  return card.getByRole("button", { name: "Remind me", exact: true });
}

test("the first Remind me click survives a same-room snapshot during the load", { timeout: 60000 }, async t => {
  const { f, page, errors } = await harness(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/src/reminders.js*", async route => { await gate; await route.continue(); });
  const button = await remindButton(page);
  await button.click();
  // While the import is held, ordinary same-room traffic lands and the
  // client takes fresh snapshots of the room the page is already viewing.
  f.store.command(f.keys.producer, "commons", { id: "snap-m1", type: "message.posted", data: { messageId: "snap-m1", body: "Snapshot ping one." } });
  f.store.command(f.keys.owner, "commons", { id: "snap-m2", type: "message.posted", data: { messageId: "snap-m2", body: "Snapshot ping two." } });
  await page.waitForTimeout(500);
  release();
  await page.locator("#reminder-dialog[open]").waitFor();
  assert.deepEqual(errors, []);
});

test("no replay when the trigger leaves the document during the load", { timeout: 60000 }, async t => {
  const { page, errors } = await harness(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/src/reminders.js*", async route => { await gate; await route.continue(); });
  const button = await remindButton(page);
  await button.click();
  await button.evaluate(node => node.remove());
  release();
  await page.waitForTimeout(700);
  assert.equal(await page.locator("#reminder-dialog[open]").count(), 0, "a detached trigger is not replayed");
  assert.deepEqual(errors, []);
});
