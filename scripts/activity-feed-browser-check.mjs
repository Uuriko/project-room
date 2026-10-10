// Attention: Activity feed, Later (saved messages), Mark unread, and the
// read-horizon "New messages" divider. Real browser + local HTTP service;
// all identities, messages, and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { clickChrome } from "./room-chrome.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`activity feed ${label}: badge, filters, open-and-read, save/unsave, mark unread divider`, { timeout: 120000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser;
    t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
    // Before the owner arrives: one @mention and one reply to the owner's welcome.
    send("guest", T.MESSAGE_POSTED, { messageId: "mention-owner", body: "@owner could you confirm the agenda?" });
    send("guest", T.MESSAGE_POSTED, { messageId: "reply-owner", body: "Thanks for the welcome.", replyToId: "test-welcome" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/activity-feed-${label}-${name}.png` }); };

    await page.goto(origin);
    await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });

    // Secondary navigation stays collapsed while chat is immediately usable.
    assert.equal(await page.locator("#room-more").evaluate(node => node.open), false);
    assert.equal(await page.locator("#topbar-activity").isVisible(), false);
    await page.locator("#room-more > summary").focus();
    await page.keyboard.press("Enter");
    await page.locator("#topbar-activity").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#room-more > summary").evaluate(node => node === document.activeElement), true);
    await page.locator("#room-more > summary").click();
    // The Activity badge counts the two unread items.
    const activityBadge = page.locator("#activity-count");
    await activityBadge.waitFor({ state: "visible" });
    assert.equal(await activityBadge.textContent(), "2");

    // The dialog lists both items; the Mentions filter narrows to one.
    await clickChrome(page, "#topbar-activity");
    const dialog = page.locator("#activity-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#activity-list .activity-item").first().waitFor();
    assert.equal(await page.locator("#activity-list .activity-item").count(), 2);
    await page.locator('#activity-filters [data-activity-filter="mention"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#activity-list .activity-item").length === 1);
    assert.match(await page.locator("#activity-list .activity-item").first().textContent(), /mentioned you/);
    await page.locator('#activity-filters [data-activity-filter=""]').click();
    await page.waitForFunction(() => document.querySelectorAll("#activity-list .activity-item").length === 2);

    // Opening an item jumps to the message and marks that item read.
    await page.locator('#activity-list .activity-item a[data-open-message="mention-owner"]').click();
    await page.waitForFunction(() => location.hash.startsWith("#pr-record/message/mention-owner"));
    await dialog.waitFor({ state: "hidden" });
    // Mark all read clears the badge.
    await clickChrome(page, "#topbar-activity");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#activity-read-all").click();
    await page.waitForFunction(() => document.querySelector("#activity-count").hidden);
    await page.keyboard.press("Escape");
    await capture("read");

    // Save from the message overflow menu; Later badge counts it.
    const target = page.locator('[data-message-record-id="test-request"]');
    await target.locator(".message-more > summary").click();
    const saveButton = target.locator('[data-message-action="save"]');
    await saveButton.click();
    const laterBadge = page.locator("#later-count");
    await page.waitForFunction(() => document.querySelector("#later-count").textContent === "1");
    assert.equal(await laterBadge.textContent(), "1");
    // The menu label flips to Unsave while the message is saved.
    await target.locator(".message-more > summary").click();
    assert.equal(await target.locator('[data-message-action="save"]').textContent(), "Unsave");
    await page.keyboard.press("Escape");

    // The Later dialog lists the saved message; Unsave clears it.
    await clickChrome(page, "#topbar-later");
    const laterDialog = page.locator("#later-dialog");
    await laterDialog.waitFor({ state: "visible" });
    await page.locator("#later-list .later-item").first().waitFor();
    assert.equal(await page.locator("#later-list .later-item").count(), 1);
    await page.locator('#later-list [data-unsave-message]').click();
    await page.waitForFunction(() => document.querySelector("#later-count").hidden);
    await page.keyboard.press("Escape");

    // Mark unread rewinds the read horizon: the "New messages" divider
    // appears above the chosen message.
    const unreadTarget = page.locator('[data-message-record-id="mention-owner"]');
    await unreadTarget.locator(".message-more > summary").click();
    await unreadTarget.locator('[data-message-action="mark-unread"]').click();
    // Another unread divider may already exist before the asynchronous horizon
    // write finishes. Wait for this action's specific message, not that old one.
    await unreadTarget.locator('.chat-divider.unread', { hasText: "New messages" }).waitFor({ state: "visible" });
    // The divider renders at the top of the marked message's own element.
    const dividerInside = await page.evaluate(() => {
      const node = document.querySelector('[data-message-record-id="mention-owner"]');
      return node ? node.querySelector(".chat-divider.unread") !== null : false;
    });
    assert.ok(dividerInside, "unread divider renders inside the marked message's element");
    await capture("unread");

    // Scrolling to the bottom advances the horizon (debounced): the divider
    // clears because everything in view now counts as read. Synthetic scroll
    // events cover viewports where the list has no scrollable overflow.
    await page.evaluate(() => {
      const list = document.querySelector("#message-list");
      if (list) { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event("scroll")); }
      window.scrollTo(0, document.body.scrollHeight);
      window.dispatchEvent(new Event("scroll"));
    });
    await page.waitForFunction(() => !document.querySelector(".chat-divider.unread"), undefined, { timeout: 15000 });
    await capture("read-again");

    assert.deepEqual(errors, [], "no page errors");
  });
}

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`activity shortcuts ${label}: keyboard open, mark-unread key, room-actions entries`, { timeout: 120000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser;
    t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
    send("guest", T.MESSAGE_POSTED, { messageId: "mention-owner", body: "@owner could you confirm the agenda?" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.goto(origin);
    await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });

    // `g a` opens Activity from the keyboard.
    await page.locator("#message-list").click();
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    const dialog = page.locator("#activity-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.locator("#activity-list .activity-item").first().waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // `g l` opens Later.
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    const laterDialog = page.locator("#later-dialog");
    await laterDialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");

    // `u` with a message focused marks it unread: the divider appears.
    const target = page.locator('[data-message-record-id="mention-owner"]');
    await target.focus();
    await page.keyboard.press("u");
    await page.locator('.chat-divider.unread', { hasText: "New messages" }).first().waitFor({ state: "visible" });

    // The room-actions palette lists Activity and Later entries (desktop:
    // the palette button is hidden on small screens).
    if (!mobile) {
      await clickChrome(page, "#room-actions-open");
      const actionsDialog = page.locator("#room-actions-dialog");
      await actionsDialog.waitFor({ state: "visible" });
      await page.locator("#room-actions-query").fill("activity");
      await page.waitForFunction(() => [...document.querySelectorAll("#room-actions-list [data-room-action]")].some(el => el.textContent.toLowerCase().includes("activity")));
      await page.locator("#room-actions-list [data-room-action]").first().click();
      await dialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
    }

    assert.deepEqual(errors, [], "no page errors");
  });
}

// A returning reader keeps the "New messages" divider until they act. Opening
// the room scrolls to the bottom by itself; that alone must not mark it read.
test("opening a room is not reading it: the divider survives open and clears on the reader's first input", { timeout: 120000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  send("guest", T.MESSAGE_POSTED, { messageId: "seen-before", body: "Seen before you left." });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator('[data-message-record-id="seen-before"]').waitFor();
  // The reader reads to the bottom: real input, so the horizon moves.
  const horizonWrite = page.waitForResponse(response => response.request().method() !== "GET" && /horizon/i.test(new URL(response.url()).pathname));
  await page.locator("#message-list").hover();
  await page.mouse.wheel(0, 2000);
  await horizonWrite;
  // They leave; 6 messages arrive.
  await page.goto("about:blank");
  for (let i = 0; i < 6; i++) send("guest", T.MESSAGE_POSTED, { messageId: `away-${i}`, body: `While you were away ${i}` });
  await page.goto(origin);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator('[data-message-record-id="away-5"]').waitFor();
  const divider = page.locator('[data-message-record-id="away-0"] .chat-divider.unread');
  await divider.waitFor({ state: "attached" });
  // Well past the 1.5 s debounce, with no input: still unread.
  await page.waitForTimeout(3500);
  assert.equal(await divider.count(), 1, "the divider is still there after open, before any input");
  // The reader's first input at the bottom marks the room read.
  await page.locator("#message-list").hover();
  await page.mouse.wheel(0, 4000);
  await page.waitForFunction(() => !document.querySelector(".chat-divider.unread"), undefined, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

// PRIV-2 honesty: a link guest who sees only messages from after they joined
// is told why the chat is empty, instead of "No messages yet" in a busy room.
test("a since-join guest gets the honest empty chat, not 'No messages yet'", { timeout: 120000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
  let browser;
  t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.ROOM_HISTORY_VISIBILITY_SET, data: { historyVisibility: "since_join" } });
  f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "before-guest", body: "Posted before the guest arrived." } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  guest.setDefaultTimeout(12000);
  const errors = [];
  guest.on("pageerror", error => errors.push(error.message));
  await guest.goto(`${origin}/#join/${f.links.valid}`);
  await guest.locator("#join-link-name").fill("Late guest");
  await guest.locator("#join-link-submit").click();
  await guest.locator("#join-link-dialog").waitFor({ state: "hidden" });
  const note = guest.locator("#message-list [data-empty-since-join]");
  await note.waitFor({ state: "visible" });
  assert.match(await note.textContent(), /Earlier messages, if there are any, aren't shared with you/);
  assert.equal(await guest.locator("#message-list .empty-note", { hasText: "No messages yet" }).count(), 0);
  assert.equal(await guest.locator('[data-message-record-id="before-guest"]').count(), 0, "the pre-join message stays hidden");
  assert.equal(await guest.locator("#message-list [data-empty-invite]").count(), 0, "no Invite offer in the guest's empty chat");
  assert.deepEqual(errors, []);
});
