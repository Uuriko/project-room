// Local qualification of the H1 recipe strip against disposable first-party data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openCatchUp, closeCatchUp, openSettings, ensureSidebarOpen } from "./room-chrome.mjs";

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
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await openSettings(page, "room-tools");
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
  await openSettings(page, "room-tools");
  await strip.locator('[data-recipe-action="open-catch-up"]').click();
  await page.locator("#catchup-dialog").waitFor({ state: "visible" });
  await openCatchUp(page);
  await closeCatchUp(page);
  await openSettings(page, "room-tools");
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

for (const kind of ["work", "request"]) for (const [width, theme] of [[1280, "dark"], [390, "light"]]) {
  test(`recipe destination ${kind} at ${width}px ${theme} preserves thread drafts and Back`, { timeout: 60000 }, async t => {
    const f = createAcceptanceFixture({ dmConsent: true });
    const server = createRoomServer({ store: f.store, streamInterval: 40 });
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const send = (role, type, data) => f.store.command(f.keys[role], "commons", { id: crypto.randomUUID(), type, data });
    send("owner", "channel.created", { channelId: "side", name: "side" });
    send("owner", "message.posted", { messageId: "origin-thread", body: "Keep this discussion", channelId: "side" });
    send("owner", "message.posted", { messageId: "origin-reply", body: "A reply", replyToId: "origin-thread" });
    if (kind === "work") send("owner", "work.proposed", { workItemId: "destination-work", title: "Inspect suggested work", definitionOfDone: "Inspected", accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
    else send("guest", "message.posted", { messageId: "destination-request", body: "Please inspect this request", toMemberId: "owner", requestKind: "reply" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await signInFixture(page, f.keys.owner);
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.locator("#message-input").fill("Room draft stays here");
    await ensureSidebarOpen(page); await page.locator('[data-channel="side"]').click();
    await page.locator("#message-input").fill("Channel draft stays here");
    await page.locator('[data-message-record-id="origin-thread"] [data-message-action="thread"]').click();
    await page.locator("#message-input").fill("Thread draft stays here");
    const before = f.store.snapshot(f.keys.owner, "commons").state;
    await openSettings(page, "room-tools");
    const selector = `[data-recipe-action="${kind === "work" ? "focus-work" : "open-chat"}"]`;
    const suggestion = page.locator(selector);
    await suggestion.focus(); await page.keyboard.press("Enter");
    const target = page.locator(kind === "work" ? '[data-work-record-id="destination-work"]' : '[data-message-record-id="destination-request"]');
    await target.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.matches('[data-work-record-id="destination-work"], [data-message-record-id="destination-request"]'));
    if (kind === "work") assert.equal(await target.locator("details.work-details").evaluate(node => node.open), true);
    else assert.equal(await target.locator('[data-message-action="request-answered"]').isVisible(), true);
    assert.equal(await page.locator("#message-input").inputValue(), "Room draft stays here");
    assert.equal(await page.locator("#request-mode-bar").isVisible(), false, "inspection does not start an answer");
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({ path: `test-results/recipe-${kind}-${theme}.png`, fullPage: true });
    await page.locator("#work-navigation-return").click();
    await page.waitForFunction(() => document.querySelector("#message-input").value === "Thread draft stays here");
    await page.locator("#thread-back").click();
    assert.equal(await page.locator("#message-input").inputValue(), "Channel draft stays here");
    assert.deepEqual(f.store.snapshot(f.keys.owner, "commons").state.workItems, before.workItems);
    assert.deepEqual(f.store.snapshot(f.keys.owner, "commons").state.messages, before.messages);
    if (kind === "request") {
      await openSettings(page, "room-tools");
      const staleControl = await suggestion.evaluate(node => node.outerHTML);
      send("guest", "reply_request.cancelled", { requestMessageId: "destination-request", expectedRequestRevision: 0, reason: "Resolved elsewhere" });
      await suggestion.waitFor({ state: "detached" });
      // Reproduce a retained control clicked after its underlying request changed.
      await page.locator("#recipe-strip").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), staleControl);
      await suggestion.click();
      assert.equal(await page.locator("#settings-dialog").isVisible(), true);
      assert.equal(await page.locator("#message-input").inputValue(), "Channel draft stays here");
      assert.equal(f.store.snapshot(f.keys.owner, "commons").state.replyRequests["destination-request"].status, "cancelled");
      assert.deepEqual(f.store.snapshot(f.keys.owner, "commons").state.messages, before.messages);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
  });
}
