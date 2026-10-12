// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
// muse-room 12609, option (a) per 12716: a send whose response is lost but
// whose message lands is marked Sent on its row. The draft and the
// exact-receipt retry stay: resending unchanged posts once.
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

test("a landed send with a lost response is marked Sent; the retry stays exact", { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-landed-mark-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
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

  const body = "Landed while the response was lost";
  const posted = () => store.room("commons").state.messages.filter(message => message.body === body);
  const ids = [];
  let lose = true;
  await page.route("**/api/rooms/commons/commands", async route => {
    ids.push(route.request().postDataJSON().id);
    if (lose) { lose = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  const input = page.locator("#message-input");
  await input.fill(body);
  await page.locator('#message-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
  const row = page.locator(`[data-message-record-id="${posted()[0].id}"]`);
  await row.locator("[data-sent-mark]").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await input.inputValue(), body, "the draft is kept");

  // Resending unchanged reuses the same id: one message, and the mark goes.
  await page.locator('#message-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("#message-input").disabled && !document.querySelector("#message-input").value);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(posted().length, 1);
  await row.locator("[data-sent-mark]").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
});
