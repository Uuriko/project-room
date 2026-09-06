// Quiet Focus final causal proofs (Codex 5557784549): post-connect stream loss
// transition, and measurable reflow at 390px and 200%-zoom-equivalent CSS width.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function boot(t, viewport) {
  const directory = mkdtempSync(join(tmpdir(), "room-final-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport, reducedMotion: "reduce" })).newPage();
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  return { store, server, page };
}

test("post-connect loss: Connected first, established stream killed, reconnect blocked, transition observed and never silently back", { timeout: 60000 }, async t => {
  const { server, page } = await boot(t, { width: 390, height: 844 });
  const status = page.locator("#connection-status");
  // 1. observe the exact Connected label first
  await page.waitForFunction(() => document.querySelector("#connection-status").textContent.startsWith("Connected to room service"), null, { timeout: 10000 });
  // 2. block any reconnect/refresh success, THEN terminate the established stream server-side
  await page.route("**/api/rooms/commons/stream**", route => route.abort("failed"));
  await page.route("**/api/rooms/commons", route => route.abort("failed"));
  server.closeStreams();
  // 3. observe the transition to a non-operational label
  await page.waitForFunction(() => /Reconnecting|interrupted/.test(document.querySelector("#connection-status").textContent), null, { timeout: 15000 });
  const mid = await status.textContent();
  assert.match(mid, /Reconnecting|interrupted/);
  // 4. while the reconnect path stays blocked, it must never drift back to Connected
  await page.waitForTimeout(4000);
  const late = await status.textContent();
  assert.doesNotMatch(late, /^Connected/, "no silent return to Connected without evidence");
  await page.screenshot({ path: "test-results/final-post-connect-loss.png", fullPage: true });
});

for (const [label, viewport] of [["390px", { width: 390, height: 844 }], ["200pct-zoom-equivalent", { width: 195, height: 422 }]]) {
  test(`reflow at ${label}: no horizontal overflow on document or composer; send/retry and error controls visible`, { timeout: 60000 }, async t => {
    const { page } = await boot(t, viewport);
    const doc = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(doc[0] <= doc[1], `document scrollWidth ${doc[0]} <= clientWidth ${doc[1]}`);
    const composer = await page.locator("#message-form").evaluate(e => [e.scrollWidth, e.clientWidth]);
    assert.ok(composer[0] <= composer[1], `composer scrollWidth ${composer[0]} <= clientWidth ${composer[1]}`);
    const sendButton = page.locator('#message-form button[type="submit"]');
    await sendButton.scrollIntoViewIfNeeded();
    assert.ok(await sendButton.isVisible(), "Send control visible");
    const box = await sendButton.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, `Send control inside the ${viewport.width}px viewport`);
    // failure path: the composer-local error and the retry control are both in the viewport
    await page.route("**/api/rooms/commons/commands", route => route.abort("failed"));
    await page.locator("#message-input").fill("reflow failure probe");
    await sendButton.click();
    const composerStatus = page.locator("#composer-status");
    await composerStatus.waitFor({ state: "visible" });
    const errBox = await composerStatus.boundingBox();
    assert.ok(errBox && errBox.x >= 0 && errBox.x + errBox.width <= viewport.width, "composer error inside the viewport");
    assert.ok(await sendButton.isEnabled(), "retry control (Send) enabled beside the error");
    await page.screenshot({ path: `test-results/final-reflow-${label}.png`, fullPage: true });
  });
}
