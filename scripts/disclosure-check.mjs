// Quiet Focus A1/A2 evidence: a background snapshot must not collapse an open
// disclosure, steal focus, or clear a draft. Real browser + local HTTP service;
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

test("background updates preserve open disclosures, focus, draft and recipient", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-disclosure-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
  send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  send(owner, T.MEMBER_ADDED, { memberId: "room-agent", displayName: "Room agent", kind: "agent", permissions: [] });
  const human = store.issueAccessKey("commons", "maya");
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser, page, other;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage(); other = await otherContext.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  other.on("pageerror", error => errors.push(error.message));
  const login = async (p, key) => {
    await p.goto(origin);
    await p.locator("#auth-panel").waitFor({ state: "visible" });
    await p.locator("#access-key").fill(key);
    await p.getByRole("button", { name: "Enter room", exact: true }).click();
    await p.locator("#main").waitFor({ state: "visible" });
  };
  await login(page, owner); await login(other, human);

  // A1: draft, recipient, caret in the composer
  const input = page.locator("#message-input");
  await input.fill("Draft survives a background update");
  await page.locator("#message-to-select").selectOption("maya");
  await input.evaluate(e => e.setSelectionRange(6, 13));

  // A2: open a disclosure in the presence list and keep focus on its summary
  const summary = page.locator('#presence-list .presence-member[data-disclosure-host="maya"] summary');
  await summary.click();
  const details = page.locator('#presence-list .presence-member[data-disclosure-host="maya"] details');
  assert.equal(await details.evaluate(d => d.open), true, "disclosure opens");
  await summary.focus();
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "SUMMARY");

  // Background update arrives while the disclosure is open and focused
  await other.locator("#message-input").fill("background ping from Maya");
  await other.locator('#message-form button[type="submit"]').click();
  await page.getByText("background ping from Maya", { exact: true }).waitFor();

  // A2: disclosure still open, focus still on the summary (not yanked to the composer)
  assert.equal(await details.evaluate(d => d.open), true, "background update must not collapse an open disclosure");
  assert.equal(await page.evaluate(() => document.activeElement.tagName), "SUMMARY", "focus follows the user's action, not the update");
  // A1: draft, recipient and caret survive
  assert.equal(await input.inputValue(), "Draft survives a background update");
  assert.equal(await page.locator("#message-to-select").inputValue(), "maya");
  mkdirSync("test-results", { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "test-results/disclosure-open-after-update.png", fullPage: true });

  // A2 reversible: closing the disclosure stays closed across the next background update
  await summary.click();
  assert.equal(await details.evaluate(d => d.open), false);
  await other.locator("#message-input").fill("second background ping");
  await other.locator('#message-form button[type="submit"]').click();
  await page.getByText("second background ping", { exact: true }).waitFor();
  assert.equal(await details.evaluate(d => d.open), false, "a closed disclosure must stay closed");

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: "test-results/disclosure-quiet-focus.png", fullPage: true });
  assert.deepEqual(errors, []);
});
