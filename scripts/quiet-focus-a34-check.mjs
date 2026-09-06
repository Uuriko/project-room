// Quiet Focus A3/A4 evidence: keyboard-operable disclosures, usable narrow
// composer, composer-local send failure with Send-as-retry, and explicit
// disconnected/reconnecting states. Real browser + local HTTP service;
// all identities, messages, and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

test("A3/A4: keyboard disclosures, narrow composer, composer-local failure + retry, explicit disconnect state", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-a34-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });

  // A3 keyboard: focus a disclosure summary, toggle with Enter; opening must not
  // move focus into the panel; closing must not strand focus.
  const summary = page.locator('#presence-list .presence-member[data-disclosure-host="maya"] summary');
  const details = page.locator('#presence-list .presence-member[data-disclosure-host="maya"] details');
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await details.evaluate(d => d.open), true, "keyboard opens the disclosure");
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "SUMMARY", "focus stays on the control, not forced into the panel");
  await page.keyboard.press("Enter");
  assert.equal(await details.evaluate(d => d.open), false, "keyboard closes the disclosure");
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "SUMMARY", "closing does not strand focus");

  // A3 narrow: composer usable at 390px - multiline via Enter, send via Ctrl+Enter.
  const input = page.locator("#message-input");
  await input.click();
  await input.pressSequentially("line one");
  await page.keyboard.press("Enter");
  await input.pressSequentially("line two");
  assert.equal(await input.inputValue(), "line one\nline two", "Enter stays a newline");
  await input.press("Control+Enter");
  await page.getByText("line one", { exact: false }).waitFor();
  assert.equal(await input.inputValue(), "", "Ctrl+Enter sends and clears after ack");

  // A4: simulated failure leaves the draft intact with the error at the composer; Send retries.
  await page.route("**/api/rooms/commons/commands", route => route.abort("failed"));
  await input.fill("send this through an outage");
  await page.locator('#message-form button[type="submit"]').click();
  const composerStatus = page.locator("#composer-status");
  await composerStatus.waitFor({ state: "visible" });
  assert.match(await composerStatus.textContent(), /Draft kept; press Send to retry\./);
  assert.equal(await input.inputValue(), "send this through an outage", "draft intact after failure");
  assert.equal(await page.locator('#message-form button[type="submit"]').isEnabled(), true, "Send stays available as the retry");
  await page.screenshot({ path: "test-results/a4-send-failure.png", fullPage: true });

  // Successful retry clears the draft only after acknowledgement.
  await page.unroute("**/api/rooms/commons/commands");
  await page.locator('#message-form button[type="submit"]').click();
  await page.getByText("send this through an outage", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "", "draft clears after ack");
  assert.equal(await composerStatus.isVisible(), false, "composer error clears after ack");

  // A4: lost stream is labeled reconnecting/interrupted, never silently operational.
  await page.route("**/api/rooms/commons/stream**", route => route.abort("failed"));
  await page.route("**/api/rooms/commons", route => route.abort("failed"));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.locator("#connection-status").evaluate(e => e.textContent = e.textContent); // settle
  await page.waitForFunction(() => /Reconnecting|interrupted|unavailable/.test(document.querySelector("#connection-status").textContent), null, { timeout: 15000 });
  const statusText = await page.locator("#connection-status").textContent();
  assert.doesNotMatch(statusText, /^Connected/, "a lost connection never reads as connected");
  await page.screenshot({ path: "test-results/a4-disconnected.png", fullPage: true });
  assert.deepEqual(errors, []);
});
