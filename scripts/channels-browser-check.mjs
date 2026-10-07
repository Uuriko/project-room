// Simulated human journey against disposable first-party data, not human research.
// Phase 2 channels: the sidebar lists the main channel plus created channels,
// creating/renaming/archiving flows through the dialog, and each channel shows
// only its own messages.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSettings, closeSettings, ensureSidebarClosed } from "./room-chrome.mjs";

async function setup(t, viewport = { width: 1440, height: 1000 }) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
  for (let i = 0; i < 18; i++) f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "message.posted",
    data: { messageId: `channel-history-${i}`, body: `Earlier conversation ${i}: keep the reader's place while switching destinations.\nA second line provides realistic message height.` } });
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "message.posted",
    data: { messageId: "general-thread-reply", body: "A reply in the general discussion", replyToId: "channel-history-0" } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, [], "no outside requests"); });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  // A single-thread human room keeps channel controls under Advanced.
  // Exercise that actual choice, then the existing channel-management journey.
  await page.waitForFunction(() => document.body.classList.contains("human-experience"));
  assert.equal(await page.locator('#channel-list [data-channel]').first().isVisible(), false);
  await openSettings(page);
  await page.locator('#advanced-room-tools > summary').click();
  await page.locator('#human-advanced').check();
  await closeSettings(page);
  if (viewport.width < 700) await page.locator("#sidebar-toggle").click();
  await page.locator('#channel-list [data-channel]').first().waitFor({ state: "visible" });
  const post = async body => {
    await ensureSidebarClosed(page);
    await page.locator("#message-input").fill(body);
    await page.locator("#message-form button[type=submit]").click();
    await page.locator("#message-list .message-body", { hasText: body }).first().waitFor({ state: "visible" });
  };
  const channelRow = name => page.locator(".channel-row").filter({ hasText: name });
  return { ...f, page, post, channelRow };
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`channels ${label}: create, per-channel timeline, rename, archive`, { timeout: 90000 }, async t => {
    const f = await setup(t, viewport), { page } = f;
    const names = () => page.locator("#channel-list .channel-name").allTextContents();
    // On mobile the sidebar is an overlay; Escape dismisses it along with dialogs.
    const ensureSidebar = async () => {
      if (label !== "mobile") return;
      if (!await page.locator("#main.sidebar-open").count()) await page.locator("#sidebar-toggle").click();
    };

    assert.deepEqual(await names(), ["general"], "the main channel is the only channel at first");
    assert.equal(await page.locator("#conversation-title").textContent(), "# general");

    // Bad names are rejected in the dialog.
    await ensureSidebar();
    await page.locator("#create-channel-button").click();
    await page.locator("#channel-dialog").waitFor({ state: "visible" });
    await page.locator("#channel-name-input").fill("Bad Name!");
    await page.locator("#channel-save-button").click();
    await page.locator("#channel-form-status", { hasText: /Channel name/ }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await ensureSidebar();

    // Create #design and land in it.
    await ensureSidebar();
    await page.locator("#create-channel-button").click();
    await page.locator("#channel-name-input").fill("design");
    await page.locator("#channel-save-button").click();
    await page.locator("#conversation-title", { hasText: "# design" }).waitFor({ state: "visible" });
    assert.deepEqual(await names(), ["general", "design"]);

    // Messages stay in their channel.
    await f.post("design mockup v2");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
    await page.locator("#conversation-title", { hasText: "# general" }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-list .message-body", { hasText: "design mockup v2" }).count(), 0,
      "the design message is not in the main channel timeline");
    await f.post("hello main");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();
    assert.equal(await page.locator("#message-list .message-body", { hasText: "hello main" }).count(), 0,
      "the main-channel message is not in the design timeline");
    assert.equal(await page.locator("#message-list .message-body", { hasText: "design mockup v2" }).count(), 1);

    // Navigation must not carry unsent text into a different channel. The
    // channel journey owns this real composer + tab-recovery contract.
    await page.locator("#message-input").fill("Unsent design notes");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "", "new channel has its own draft");
    await page.locator("#message-input").fill("Unsent general notes");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "Unsent design notes");
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-input").inputValue(), "Unsent design notes", "selected channel draft survives reload");
    await f.post("design draft sent after reload");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "Unsent general notes", "sending clears only its destination draft");
    const readerPosition = label === "desktop" ? await page.locator("#message-list").evaluate(list => { list.scrollTop = 420; return list.scrollTop; }) : null;
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "");
    if (readerPosition !== null) {
      await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
      const returned = await page.locator("#message-list").evaluate(list => list.scrollTop);
      assert.ok(readerPosition > 0 && Math.abs(returned - readerPosition) < 3, "return to the same reading position");
      await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();
    }
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
    await page.locator('[data-message-record-id="channel-history-0"] .thread-link').click();
    await page.locator("#message-input").fill("Unsent general thread reply");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();
    await page.locator("#thread-bar").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#message-input").inputValue(), "");
    assert.equal(await page.locator("#message-list .message-body", { hasText: "A reply in the general discussion" }).count(), 0, "a previous channel thread does not remain under the new channel header");
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "Unsent general notes");
    await page.locator('[data-message-record-id="channel-history-0"] .thread-link').click();
    assert.equal(await page.locator("#message-input").inputValue(), "Unsent general thread reply");
    await page.locator("#thread-back").click();
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();

    // Rename through the manage control.
    await ensureSidebar();
    await f.channelRow("design").locator("[data-channel-manage]").click();
    await page.locator("#channel-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#channel-dialog-title").textContent(), "Channel settings");
    await page.locator("#channel-name-input").fill("ux");
    await page.locator("#channel-save-button").click();
    await page.locator("#conversation-title", { hasText: "# ux" }).waitFor({ state: "visible" });
    assert.deepEqual(await names(), ["general", "ux"]);

    await page.locator("#message-input").fill("Keep these archived design notes");

    // Archive (two clicks) removes the channel and returns to the main channel.
    await ensureSidebar();
    await f.channelRow("ux").locator("[data-channel-manage]").click();
    await page.locator("#channel-archive-button").click();
    assert.equal(await page.locator("#channel-archive-button").textContent(), "Confirm archive");
    await page.locator("#channel-archive-button").click();
    await page.locator("#conversation-title", { hasText: "# general" }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-input").inputValue(), "Unsent general notes", "archival never moves its draft into general");
    assert.deepEqual(await names(), ["general"], "archived channel leaves the sidebar");
    assert.equal(await f.page.locator("#channel-list [data-channel-manage]").count(), 0,
      "the main channel has no manage control");
  });
}
