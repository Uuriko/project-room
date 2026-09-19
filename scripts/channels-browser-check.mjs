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
import { fillAccessKey } from "./auth-signin.mjs";

async function setup(t, viewport = { width: 1440, height: 1000 }) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 40 });
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
  await fillAccessKey(page, f.keys.owner);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  if (viewport.width < 700) await page.locator("#sidebar-toggle").click();
  await page.locator('#channel-list [data-channel]').first().waitFor({ state: "visible" });
  const post = async body => {
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

    // Rename through the manage control.
    await ensureSidebar();
    await f.channelRow("design").locator("[data-channel-manage]").click();
    await page.locator("#channel-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#channel-dialog-title").textContent(), "Channel settings");
    await page.locator("#channel-name-input").fill("ux");
    await page.locator("#channel-save-button").click();
    await page.locator("#conversation-title", { hasText: "# ux" }).waitFor({ state: "visible" });
    assert.deepEqual(await names(), ["general", "ux"]);

    // Archive (two clicks) removes the channel and returns to the main channel.
    await ensureSidebar();
    await f.channelRow("ux").locator("[data-channel-manage]").click();
    await page.locator("#channel-archive-button").click();
    assert.equal(await page.locator("#channel-archive-button").textContent(), "Confirm archive");
    await page.locator("#channel-archive-button").click();
    await page.locator("#conversation-title", { hasText: "# general" }).waitFor({ state: "visible" });
    assert.deepEqual(await names(), ["general"], "archived channel leaves the sidebar");
    assert.equal(await f.page.locator("#channel-list [data-channel-manage]").count(), 0,
      "the main channel has no manage control");
  });
}
