// Decision register (backlog F2) browser check: a human with decide promotes a
// message into a source-backed decision record; members without decide get no
// such affordance. Disposable rooms only - no real users or outside requests.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";

async function setup(t, key = "owner") {
  const f = createAcceptanceFixture({ managedProducer: false }), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await fillAccessKey(page, f.keys[key]); await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page };
}

test("a human with decide records a source-backed decision from a message", { timeout: 30000 }, async t => {
  const { page, store, keys } = await setup(t);
  const button = page.locator('[data-message-action="decide"][data-message-id="test-welcome"]');
  await button.waitFor({ state: "visible" });
  await button.click();
  await page.locator("#decision-dialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#decision-source").textContent(), /Disposable test room/);
  await page.locator("#decision-statement-input").fill("Weekly agenda ships every Friday.");
  await page.locator("#decision-note-input").fill("Pilot policy");
  await page.locator('#decision-form button[type="submit"]').click();
  await page.getByText("Decision recorded.", { exact: true }).waitFor();
  const list = page.locator("#decision-list");
  await page.locator("#decision-count").filter({ hasText: "1" }).waitFor({ state: "attached" });
  await page.locator("#record-panel > summary").click();
  await page.locator("#decision-section > summary").click();
  await list.locator("li").first().waitFor({ state: "visible" });
  assert.match(await list.textContent(), /Weekly agenda ships every Friday\./);
  assert.match(await list.textContent(), /Pilot policy/);
  const source = list.locator('[data-open-message="test-welcome"]');
  assert.equal(await source.count(), 1);
  const recorded = store.eventsAfter(keys.owner, "commons", 0).events.filter(e => e.event.type === T.DECISION_RECORDED);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].event.data.sourceMessageId, "test-welcome");
  assert.equal(recorded[0].event.data.statement, "Weekly agenda ships every Friday.");
  assert.equal(recorded[0].event.actorId, "owner");
});

test("members without decide see no record-decision affordance", { timeout: 30000 }, async t => {
  const { page } = await setup(t, "guest");
  await page.locator('a.message-time[data-open-message="test-welcome"]').waitFor({ state: "visible" });
  assert.equal(await page.locator('[data-message-action="decide"]').count(), 0);
});
