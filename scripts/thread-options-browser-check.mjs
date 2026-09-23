// Browser check for the two thread-options features, desktop and narrow:
// the thread-view Mute/Unmute button and the "Also send to channel" checkbox
// on thread replies (hidden for DMs and top-level messages).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { fillAccessKey } from "./auth-signin.mjs";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["narrow", { width: 320, height: 780 }]]) {
  test(`thread options ${label}: mute button and also-send-to-channel`, { timeout: 90000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-thread-options-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
    send(T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
    send(T.MESSAGE_POSTED, { messageId: "topic", body: "Which book should we read?" });
    send(T.MESSAGE_POSTED, { messageId: "reply", body: "A short story collection?", replyToId: "topic" });
    const server = createRoomServer({ store, streamInterval: 50 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    t.after(async () => {
      await browser.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await fillAccessKey(page, owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });

    // Open the thread view from the thread link on the root message.
    await page.locator(".thread-link").first().click();
    await page.locator("#thread-bar").waitFor({ state: "visible" });

    // The mute button is there, off by default.
    const mute = page.locator("#thread-mute");
    await mute.waitFor({ state: "visible" });
    assert.equal(await mute.textContent(), "Mute thread");
    assert.equal(await mute.getAttribute("aria-pressed"), "false");

    // The also-send checkbox shows in the thread composer, off by default.
    const alsoSend = page.locator("#also-send-to-channel");
    await page.locator("#also-send-label").waitFor({ state: "visible" });
    assert.equal(await alsoSend.isChecked(), false);

    // Mute the thread.
    await mute.click();
    await page.waitForFunction(() => document.querySelector("#thread-mute")?.textContent === "Unmute thread");
    assert.equal(await mute.getAttribute("aria-pressed"), "true");
    assert.deepEqual([...store.threadMutes.mutedThreadIds("commons", "owner")], ["topic"], "the mute is persisted server-side");

    // Unmute it again.
    await mute.click();
    await page.waitForFunction(() => document.querySelector("#thread-mute")?.textContent === "Mute thread");
    assert.deepEqual([...store.threadMutes.mutedThreadIds("commons", "owner")], [], "the unmute is persisted server-side");

    // Post a reply with "also send to channel": the thread reply appears and
    // a top-level copy lands in the channel.
    await alsoSend.check();
    await page.locator("#message-input").fill("Let's read Dune");
    await page.locator("#message-input").press("Enter");
    await page.getByText("Let's read Dune").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#also-send-to-channel")?.checked);
    const list = await store.room("commons").state.messages;
    const reply = list.find(m => m.body === "Let's read Dune" && m.replyToId === "topic");
    assert.ok(reply, "the thread reply was posted");
    const copy = list.find(m => m.id === `${reply.id}:channel`);
    assert.ok(copy, "the channel copy was posted");
    assert.equal(copy.replyToId, null);
    assert.equal(await alsoSend.isChecked(), false, "the toggle resets after a successful send");

    // The checkbox hides for DMs: addressing a member hides the option.
    // (#message-to-select is sr-only, so set it programmatically.)
    await page.evaluate(() => {
      const select = document.querySelector("#message-to-select");
      select.value = "maya";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator("#also-send-label").waitFor({ state: "hidden" });
    assert.equal(await alsoSend.isChecked(), false, "the toggle resets when hidden");

    // And it hides at the top level (back out of the thread).
    await page.locator("#thread-back").click();
    await page.locator("#thread-bar").waitFor({ state: "hidden" });
    await page.locator("#also-send-label").waitFor({ state: "hidden" });

    assert.deepEqual(errors, [], `no page errors (${label})`);
  });
}
