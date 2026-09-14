// B4 notification feed: badge, compact list, and "Mark read" moving the cursor.
// Simulated human tasks against isolated synthetic data; no real user research.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`notification feed ${label}: badge counts unread items, list opens the message, Mark read moves only the cursor`, { timeout: 90000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser;
    t.after(async () => { await browser?.close(); server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
    // Before the owner arrives: one @mention, one reply to the owner's welcome, one unrelated message.
    send("guest", T.MESSAGE_POSTED, { messageId: "mention-owner", body: "@Room owner could you confirm the agenda owner?" });
    send("guest", T.MESSAGE_POSTED, { messageId: "reply-owner", body: "Thanks for the welcome.", replyToId: "test-welcome" });
    send("producer", T.MESSAGE_POSTED, { messageId: "unrelated", body: "Working through the checklist." });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    const errors = [], external = [], writes = [];
    await context.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!["GET", "HEAD"].includes(request.method()) && request.url().startsWith(`${origin}/api/rooms/`)) writes.push(new URL(request.url()).pathname); });
    const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/notification-feed-${label}-${name}.png` }); };
    const sequenceBefore = f.store.room("commons").sequence;

    await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner); await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    // The badge shows before the panel is opened; the list is inside catch-up.
    const badge = page.locator("#notification-count");
    await badge.waitFor({ state: "visible" });
    assert.equal(await badge.textContent(), "2 for you");
    assert.equal(await page.locator("#notification-panel").isVisible(), false);
    await page.locator("#return-brief-panel > summary").click();
    await page.locator("#notification-panel").waitFor({ state: "visible" });
    const items = page.locator("#notification-list .notification-item");
    await items.nth(1).waitFor();
    assert.equal(await items.count(), 2);
    assert.deepEqual(await items.evaluateAll(nodes => nodes.map(node => node.dataset.notificationKind)), ["reply", "mention"]);
    assert.match(await items.nth(0).textContent(), /Test guest .*replied to you/);
    assert.match(await items.nth(1).textContent(), /Test guest .*mentioned you/);
    assert.equal(await page.locator("#notification-heading").textContent(), "Notifications");
    await capture("unread");
    // Opening a feed and fetching it never acknowledged anything.
    assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, 0);
    assert.deepEqual(writes, [], "no room write was sent by viewing the feed");

    // An item is a link to the message it derives from.
    await items.nth(1).locator("a").click();
    await page.waitForURL(url => url.hash.startsWith("#pr-record/message/mention-owner"));
    const row = page.locator('#message-list [data-message-record-id="mention-owner"]');
    await row.waitFor({ state: "visible" });
    assert.equal(await row.evaluate(node => node === document.activeElement || node.contains(document.activeElement)), true, "the mentioned message receives focus");
    if (!await page.locator("#return-brief-panel").evaluate(node => node.open)) await page.locator("#return-brief-panel > summary").click();

    // A failed cursor POST is reported as a failed save and moves nothing.
    let failCursor = true, failSnapshot = false;
    await page.route("**/api/rooms/commons**", async route => {
      const url = new URL(route.request().url());
      if (failCursor && route.request().method() === "POST" && url.pathname.endsWith("/cursor")) { failCursor = false; return route.abort("failed"); }
      if (failSnapshot && route.request().method() === "GET" && url.pathname === "/api/rooms/commons") { failSnapshot = false; return route.abort("failed"); }
      return route.continue();
    });
    await page.locator("#notification-read-button").click();
    await page.getByText("Could not mark read. Try again.", { exact: true }).waitFor();
    assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, 0, "an aborted POST stores nothing");
    assert.equal(await badge.textContent(), "2 for you");
    assert.equal(await page.locator("#notification-read-button").isDisabled(), false);
    // A stored marker whose follow-up room refresh fails is reported truthfully as saved but not refreshed.
    failSnapshot = true;
    await page.locator("#notification-read-button").click();
    await page.locator("#status .status-text").filter({ hasText: "Marked read. The latest room view could not be refreshed" }).waitFor();
    assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, sequenceBefore, "the marker was stored");
    assert.equal(await page.locator("#notification-status").textContent(), "", "no failed-save message for a stored marker");
    await badge.waitFor({ state: "hidden" });
    await page.locator("#status .status-dismiss").click();
    // Reset the marker so the ordinary path is exercised on the same page.
    f.store.db.prepare("DELETE FROM cursors WHERE room_id='commons' AND member_id='owner'").run();
    writes.length = 0;
    await page.locator("#refresh-button").click();
    await badge.waitFor({ state: "visible" });
    assert.equal(await badge.textContent(), "2 for you");

    // Mark read moves the cursor to exactly the evaluated sequence and clears the list; the room itself is unchanged.
    await page.locator("#notification-read-button").click();
    await badge.waitFor({ state: "hidden" });
    await page.locator("#notification-list .rb-empty").waitFor();
    assert.equal(await page.locator("#notification-list .rb-empty").textContent(), "Nothing new for you.");
    assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, sequenceBefore);
    assert.equal(f.store.room("commons").sequence, sequenceBefore, "marking read appended no event");
    assert.deepEqual(writes, ["/api/rooms/commons/cursor"], "the only write is the cursor move");
    assert.equal(await page.locator("#notification-read-button").isDisabled(), true);
    await capture("read");

    // A new mention after the marker is unread again; refresh picks it up without a reload.
    send("guest", T.MESSAGE_POSTED, { messageId: "mention-later", body: "@Room owner one more thing." });
    await page.locator("#refresh-button").click();
    await badge.waitFor({ state: "visible" });
    assert.equal(await badge.textContent(), "1 for you");
    await items.first().waitFor();
    assert.equal(await items.count(), 1);
    assert.equal(f.store.snapshot(f.keys.owner, "commons").cursor, sequenceBefore, "new items do not move the marker");

    // Large text keeps the list within the viewport width.
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    await capture("large-text");
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

    // Sign-out clears the feed and badge.
    if (await page.locator("#session-menu-button").isVisible()) await page.locator("#session-menu-button").click();
    await page.locator("#signout-button").click(); await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#notification-list").textContent(), "");
    assert.equal(await badge.textContent(), "");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
}
