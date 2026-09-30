import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { createRoomServer } from "../server/http.mjs";
import { StorageUnavailableError } from "../server/store.mjs";

test("native EventSource reconnects after temporary storage failure without losing identity, unsent draft or selection", { timeout: 20000 }, async t => {
  const f = createAcceptanceFixture(), original = f.store.eventsAfter.bind(f.store);
  let armed = false, failures = 0;
  f.store.eventsAfter = (...args) => {
    if (armed) { armed = false; failures++; throw new StorageUnavailableError(new Error("synthetic driver detail")); }
    return original(...args);
  };
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; let streams = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/stream")) streams++; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  const identity = await page.locator("#identity-label").textContent(), beforeStreams = streams;
  const draft = "An unsent private draft retained through temporary transport failure";
  await page.locator("#message-input").fill(draft);
  await page.locator("#message-input").focus();
  await page.locator("#message-input").evaluate(input => input.setSelectionRange(3, 16));
  const composer = () => page.locator("#message-input").evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }));
  const expected = await composer();
  armed = true;
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connection interrupted"));
  assert.equal(failures, 1);
  assert.equal(await page.locator("#main").isVisible(), true);
  assert.equal(await page.locator("#auth-panel").isVisible(), false);
  assert.equal(await page.locator("#identity-label").textContent(), identity);
  assert.deepEqual(await composer(), expected);
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected"));
  assert.ok(streams > beforeStreams, "native EventSource makes an actual reconnect request");
  const id = randomUUID();
  f.store.command(f.keys.owner, "commons", { id, type: "message.posted", data: { messageId: id, body: "Public arrival after native recovery" } });
  await page.locator(`[data-message-record-id="${id}"]`).waitFor({ state: "visible" });
  assert.equal(await page.locator("#identity-label").textContent(), identity);
  assert.deepEqual(await composer(), expected);
  assert.equal(f.store.room("commons").state.messages.some(message => message.body === draft), false);
  assert.deepEqual(errors, []);
});
