// Local qualification of the H1 recipe strip against disposable first-party data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { fillAccessKey } from "./auth-signin.mjs";
import { openCatchUp, closeCatchUp } from "./room-chrome.mjs";

test("recipe strip: catch-up and next-work chips render from committed state; dismissal is local only", { timeout: 60000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
  // Committed before login: one proposed item for the owner plus chatter, so the
  // owner returns to unseen activity and one actionable step.
  send("work.proposed", { workItemId: "recipe-target", title: "Sweep the weekly digest", definitionOfDone: "Digest notes filed.", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
  send("message.posted", { messageId: "recipe-chatter", body: "Notes from the morning." });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await fillAccessKey(page, f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  const strip = page.locator("#recipe-strip");
  await strip.waitFor({ state: "visible" });
  const chips = strip.locator(".recipe-chip");
  assert.equal(await chips.count(), 2);
  await strip.locator('[data-recipe-action="open-catch-up"]').waitFor();
  const suggestion = strip.locator('[data-recipe-action="focus-work"]');
  await suggestion.waitFor();
  assert.match(await strip.textContent(), /Sweep the weekly digest|Accept the assignment|Invited to contribute/);
  // Suggestion chip opens the work surface at the card.
  await suggestion.click();
  await page.locator('[data-work-record-id="recipe-target"]').waitFor({ state: "visible" });
  // Catch-up chip opens the catch-up section.
  await strip.locator('[data-recipe-action="open-catch-up"]').click();
  await page.locator("#catchup-dialog").waitFor({ state: "visible" });
  await openCatchUp(page);
  // The catch-up dialog is modal; close it before interacting with the strip behind it.
  await closeCatchUp(page);
  // Dismissal hides only that chip for this page session.
  await chips.first().locator("[data-recipe-dismiss]").click();
  assert.equal(await strip.locator(".recipe-chip").count(), 1);
  // W4-47 H6: the dry-run preview lists every catalog recipe - what it reads,
  // its trigger, what it would do, and whether it would fire now - before
  // anything is enabled. Opening the panel is a pure read.
  await page.locator("#recipe-preview-toggle").click();
  const items = page.locator("#recipe-preview .recipe-preview-item");
  assert.equal(await items.count(), 3);
  const previewText = await page.locator("#recipe-preview").textContent();
  assert.match(previewText, /Draft catch-up/);
  assert.match(previewText, /Reads:/);
  assert.match(previewText, /Would do:/);
  assert.match(previewText, /Firing now|Not firing right now/);
  assert.deepEqual(errors, []);
  mkdirSync("test-results", { recursive: true });
  await strip.screenshot({ path: "test-results/starter-recipe-strip.png" });
  assert.deepEqual(errors, []);
});
