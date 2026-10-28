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
import { ensureSidebarClosed } from "./room-chrome.mjs";

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
  // Channels are primary navigation in the human room, including a room
  // with only general. On phones they live in the normal navigation drawer.
  await page.waitForFunction(() => document.body.classList.contains("human-experience"));
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
    assert.equal(await page.locator("#main.sidebar-open").count(), 0, "creation opens the conversation rather than leaving its drawer over it");
    assert.equal(await page.locator("#message-input").evaluate(node => node === document.activeElement), true, "ready to write the first message");

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
    // Actual reader input releases the newest-message pin. Setting scrollTop
    // alone is programmatic layout movement and intentionally does not do so.
    let readerPosition = null;
    if (label === "desktop") {
      await page.locator("#message-list").hover();
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(() => {
        const list = document.querySelector("#message-list");
        return list.scrollTop > 0 && list.scrollHeight - list.clientHeight - list.scrollTop > 100;
      });
      readerPosition = await page.locator("#message-list").evaluate(list => list.scrollTop);
    }
    await ensureSidebar();
    await page.locator("#channel-list [data-channel]").filter({ hasText: "design" }).click();
    assert.equal(await page.locator("#message-input").inputValue(), "");
    if (readerPosition !== null) {
      await page.locator("#channel-list [data-channel]").filter({ hasText: "general" }).click();
      const returned = await page.locator("#message-list").evaluate(list => list.scrollTop);
      assert.ok(readerPosition > 0 && Math.abs(returned - readerPosition) < 3,
        `return to the same reading position: expected ${readerPosition}, got ${returned}`);
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

test("a delayed channel response cannot close a replacement dialog", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  let release, held;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { held = resolve; });
  t.after(() => release());
  await page.route("**/rooms/commons/commands", async route => {
    const response = await route.fetch();
    held(); await gate;
    await route.fulfill({ response });
  });
  await page.locator("#create-channel-button").click();
  await page.locator("#channel-name-input").fill("delayed-channel");
  await page.locator("#channel-save-button").click();
  await waiting;
  assert.equal(await page.locator("#channel-save-button").isDisabled(), true);
  await page.locator("#channel-dialog-close").click();
  await page.locator("#create-channel-button").click();
  assert.equal(await page.locator("#channel-name-input").isDisabled(), true);
  release();
  await page.waitForFunction(() => document.querySelector("#channel-form").getAttribute("aria-busy") !== "true");
  assert.equal(await page.locator("#channel-dialog").isVisible(), true);
  assert.equal(await page.locator("#channel-name-input").inputValue(), "");
  await page.locator("#channel-name-input").fill("replacement-draft");
  assert.equal(await page.locator("#conversation-title").textContent(), "# general");
  assert.equal(await page.locator("#channel-form-status").textContent(), "");
});

test("a delayed archive cannot close a newer channel dialog", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "channel.created", data: { channelId: "archive-late", name: "archive-late" } });
  await page.locator('[data-channel-manage="archive-late"]').waitFor();
  let release, held;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { held = resolve; });
  t.after(() => release());
  await page.route("**/rooms/commons/commands", async route => {
    const response = await route.fetch(); held(); await gate;
    await route.fulfill({ response });
  });
  await page.locator('[data-channel-manage="archive-late"]').click();
  await page.locator("#channel-archive-button").click();
  await page.locator("#channel-archive-button").click();
  await waiting;
  assert.equal(await page.locator("#channel-archive-button").isDisabled(), true);
  await page.locator("#channel-dialog-close").click();
  await page.locator("#create-channel-button").click();
  release();
  await page.waitForFunction(() => document.querySelector("#channel-form").getAttribute("aria-busy") !== "true");
  assert.equal(await page.locator("#channel-dialog").isVisible(), true);
  assert.equal(await page.locator("#channel-dialog-title").textContent(), "New channel");
  assert.equal(await page.locator("#channel-name-input").inputValue(), "");
  assert.equal(await page.locator("#channel-form-status").textContent(), "");
});

test("unchanged channel retry reconciles a committed response loss", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  const commands = []; let drop = true;
  await page.route("**/rooms/commons/commands", async route => {
    commands.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (drop) await route.abort("failed"); else await route.fulfill({ response });
  });
  await page.locator("#create-channel-button").click();
  await page.locator("#channel-name-input").fill("retry-channel");
  await page.locator("#channel-save-button").click();
  await page.locator("#channel-form-status.error").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.id === "channel-save-button");
  assert.equal(await page.locator("#channel-save-button").textContent(), "Retry");
  await page.locator("#channel-name-input").fill("different-name");
  assert.equal(await page.locator("#channel-save-button").textContent(), "Create channel");
  await page.locator("#channel-name-input").fill("retry-channel");
  assert.equal(await page.locator("#channel-save-button").textContent(), "Retry");
  drop = false;
  await page.locator("#channel-save-button").click();
  await page.locator("#channel-dialog").waitFor({ state: "hidden" });
  assert.ok(commands.length >= 2);
  assert.ok(commands.every(command => JSON.stringify(command) === JSON.stringify(commands[0])), "all retries retain the exact command");
  assert.equal(Object.values(f.store.room("commons").state.channels).filter(channel => channel.name === "retry-channel").length, 1);
  assert.equal(await page.locator("#conversation-title").textContent(), "# retry-channel");
});

test("private conversation picker supports search and arrow-key selection", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  await page.locator("#new-direct-message").click();
  const search = page.locator("#new-direct-search");
  await search.fill("Test reviewer");
  await search.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.dataset.directMember === "reviewer");
  await page.keyboard.press("ArrowUp");
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await search.fill("no-such-person");
  await search.press("ArrowDown");
  assert.equal(await search.evaluate(node => node === document.activeElement), true);
  await search.fill("Test reviewer");
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator("#new-direct-dialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#message-input").evaluate(node => node === document.activeElement), true);
  assert.match(await page.locator("#conversation-title").textContent(), /Test reviewer/);
});

test("private sends preserve room drafts and do not enter the public timeline", { timeout: 30000 }, async t => {
  const { page, store } = await setup(t);
  await page.locator("#message-input").fill("Keep this public draft");
  await page.locator("#new-direct-message").click();
  await page.locator("#new-direct-search").fill("Test reviewer");
  await page.locator("#new-direct-search").press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#message-input").inputValue(), "");
  await page.locator("#message-input").fill("Keep this private draft");
  await page.locator('#channel-list [data-channel="general"]').click();
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this public draft");
  await page.locator('#direct-message-list [data-direct-member="reviewer"]').click();
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this private draft");
  await page.locator('#message-form button[type="submit"]').click();
  await page.locator("#message-list .message-body", { hasText: "Keep this private draft" }).waitFor({ state: "visible" });
  const sent = store.room("commons").state.messages.filter(message => message.body === "Keep this private draft");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toMemberId, "reviewer");
  await page.locator('#channel-list [data-channel="general"]').click();
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this public draft");
  assert.equal(await page.locator("#message-list .message-body", { hasText: "Keep this private draft" }).count(), 0);
});

test("open recipient picker updates membership without losing keyboard context", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  await page.locator("#new-direct-message").click();
  await page.locator("#new-direct-search").fill("Test reviewer");
  await page.locator("#new-direct-search").press("ArrowDown");
  const member = f.store.room("commons").state.members.reviewer;
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.access_changed",
    data: { memberId: "reviewer", expectedMemberRevision: member.revision ?? 0, permissions: member.permissions, active: false } });
  await page.locator('#new-direct-people [data-direct-member="reviewer"]').waitFor({ state: "detached" });
  assert.equal(await page.locator("#new-direct-search").inputValue(), "Test reviewer");
  assert.equal(await page.locator("#new-direct-search").evaluate(node => node === document.activeElement), true);
  assert.match(await page.locator("#new-direct-people").textContent(), /No matching/);
  assert.equal(await page.locator("#new-direct-dialog").evaluate(node => node.open), true);
});

test("recipient removal keeps a private draft editable without offering a new send", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  await page.locator("#new-direct-message").click();
  await page.locator('#new-direct-people [data-direct-member="reviewer"]').click();
  await page.locator("#message-input").fill("Keep this private draft on removal");
  const changeAccess = active => {
    const member = f.store.room("commons").state.members.reviewer;
    f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.access_changed",
      data: { memberId: "reviewer", expectedMemberRevision: member.revision ?? 0, permissions: member.permissions, active } });
  };
  changeAccess(false);
  await page.waitForFunction(() => document.querySelector('#message-form button[type="submit"]').disabled);
  assert.equal(await page.locator("#message-input").isEnabled(), true);
  assert.equal(await page.locator("#message-input").inputValue(), "Keep this private draft on removal");
  assert.match(await page.locator("#composer-status").textContent(), /no longer has access/);
  await page.locator("#message-input").press("Enter");
  assert.equal(f.store.room("commons").state.messages.some(message => message.body === "Keep this private draft on removal"), false);
  changeAccess(true);
  await page.waitForFunction(() => !document.querySelector('#message-form button[type="submit"]').disabled);
  assert.equal(await page.locator("#composer-status").textContent(), "");
  assert.equal(await page.locator("#message-to-select").inputValue(), "reviewer");
});

test("composer expands wrapped drafts when the window narrows", { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  const draft = "Keep the entire draft readable when the window changes width and this sentence wraps onto several lines.";
  await page.locator("#message-input").fill(draft);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => { const input = document.querySelector('#message-input'); return input.scrollHeight <= input.clientHeight + 1; });
  assert.equal(await page.locator("#message-input").inputValue(), draft);
});

test("a lost send response uses matching confirmed history instead of asking for retry", { timeout: 30000 }, async t => {
  const f = await setup(t), { page } = f;
  await page.locator("#new-direct-message").click();
  await page.locator('#new-direct-people [data-direct-member="reviewer"]').click();
  await page.route("**/rooms/commons/commands", async route => {
    await route.fetch();
    await page.locator("#message-list .message-body", { hasText: "Confirmed despite lost response" }).waitFor({ state: "visible" });
    await route.abort("failed");
  });
  await page.locator("#message-input").fill("Confirmed despite lost response");
  await page.locator('#message-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#message-input').value === '');
  assert.equal(await page.locator("#composer-status").textContent(), "");
  const sent = f.store.room("commons").state.messages.filter(message => message.body === "Confirmed despite lost response");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].toMemberId, "reviewer");
});
