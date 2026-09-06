// Synthetic browser fixtures. These checks do not stand in for physical-device or human AT runs.
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

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["narrow", { width: 320, height: 780 }]]) {
  test(`composer ${label}: keyboard recovery, discussion errors, composition, and access cleanup`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-composer-"));
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
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const login = async key => {
      await page.locator("#auth-panel").waitFor({ state: "visible" });
      await page.locator("#access-key").fill(key);
      await page.getByRole("button", { name: "Enter room", exact: true }).click();
      await page.locator("#main").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#access-key").disabled);
    };
    await login(owner);
    await page.locator("#remember-drafts").check();
    const input = page.locator("#message-input"), status = page.locator("#composer-status");
    const waitForFailure = () => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
    const waitForSaved = () => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#message-input").value === "");

    await input.fill("A separate room draft");
    await page.locator('#message-topic [data-message-action="thread"]').click();
    await page.locator('#message-reply [data-message-action="reply"]').click();
    await page.locator("#message-to-select").selectOption("maya");
    await input.fill("Keep this thread reply");
    await input.focus();
    await input.evaluate(e => e.setSelectionRange(5, 9, "backward"));
    const commandIds = [];
    let loseResponse = true;
    await page.route("**/api/rooms/commons/commands", async route => {
      commandIds.push(route.request().postDataJSON().id);
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort("failed"); }
      else await route.continue();
    });
    await page.keyboard.press("Control+Enter");
    await waitForFailure();
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-input", "failed keyboard send restores its initiating field");
    assert.deepEqual(await input.evaluate(e => [e.selectionStart, e.selectionEnd, e.selectionDirection]), [5, 9, "backward"]);
    const threadError = await status.textContent();
    assert.ok(threadError.length > 0);
    assert.equal(await page.locator("#status").textContent().then(s => s.includes("Draft kept")), false, "one send-error announcement region");
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "A separate room draft");
    assert.equal(await status.textContent(), "", "a thread's send error cannot describe a different draft");
    await page.locator('#message-topic [data-message-action="thread"]').click();
    assert.equal(await status.textContent(), threadError, "returning to the failed draft restores its recovery message");
    assert.equal(await input.inputValue(), "Keep this thread reply");
    assert.equal(await page.locator("#message-to-select").inputValue(), "maya");
    assert.match(await page.locator("#reply-context").textContent(), /short story/);
    page.once("dialog", dialog => dialog.accept());
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await input.inputValue(), "Keep this thread reply");
    await input.focus();
    await page.keyboard.press("Control+Enter");
    await waitForSaved();
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-input", "successful keyboard send leaves the composer usable");
    assert.equal(await status.textContent(), "");
    assert.equal(commandIds.length, 2); assert.equal(commandIds[0], commandIds[1]);
    const messages = store.snapshot(owner, "commons").state.messages.filter(m => m.body === "Keep this thread reply");
    assert.equal(messages.length, 1); assert.equal(messages[0].replyToId, "reply"); assert.equal(messages[0].toMemberId, "maya");
    await page.unroute("**/api/rooms/commons/commands");

    // Explicit opt-in survives reload only after authenticating the same room.
    await input.fill("Recover this thread after reload");
    page.once("dialog", dialog => dialog.accept());
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await input.inputValue(), "Recover this thread after reload");
    assert.equal(await page.locator("#remember-drafts").isChecked(), true);
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "A separate room draft");
    await page.locator('#message-topic [data-message-action="thread"]').click();
    await page.locator("#remember-drafts").uncheck();
    assert.equal(await page.evaluate(() => sessionStorage.getItem("project-room:drafts:v1")), null);

    // Moving to search while a send is waiting is intentional focus movement.
    const intercepted = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/rooms/commons/commands", async route => {
      const response = await route.fetch(); intercepted.resolve(); await release.promise;
      await route.fulfill({ response });
    });
    await input.fill("Saved while I search");
    await page.keyboard.press("Control+Enter");
    await intercepted.promise;
    assert.equal(await page.locator("#message-form").getAttribute("aria-busy"), "true");
    await page.locator("#message-search").fill("short story");
    release.resolve();
    await waitForSaved();
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-search", "completion does not steal focus from search");
    assert.equal(await page.locator("#message-form").getAttribute("aria-busy"), null);
    await page.unroute("**/api/rooms/commons/commands");
    await page.locator("#clear-search").click();

    // A composition-confirmation key is not a send shortcut, including the legacy IME signal.
    await input.fill("検討中の文章");
    await input.focus();
    for (const options of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }, { repeat: true, keyCode: 13 }]) {
      const prevented = await input.evaluate((e, options) => {
        const key = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true, ...options });
        e.dispatchEvent(key); return key.defaultPrevented;
      }, options);
      assert.equal(prevented, false, "composition/repeated key is left to text entry");
      assert.equal(await input.inputValue(), "検討中の文章");
    }
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "検討中の文章\n", "ordinary Enter still inserts a line");
    await page.keyboard.press("Control+Enter");
    await waitForSaved();
    assert.equal(store.snapshot(owner, "commons").state.messages.filter(m => m.body === "検討中の文章").length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    // Access loss clears both visible error text and the errors saved with other drafts.
    await page.route("**/api/rooms/commons/commands", route => route.abort("failed"));
    await input.fill("Unsent before access ended");
    await page.keyboard.press("Control+Enter");
    await waitForFailure();
    const rotated = store.issueAccessKey("commons", "owner");
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await status.textContent(), "", "access loss clears the former session's send error");
    assert.equal(await input.inputValue(), "");
    assert.equal(await page.locator("#message-form").getAttribute("aria-busy"), null);
    await page.unroute("**/api/rooms/commons/commands");
    await login(rotated);
    await page.locator('#message-topic [data-message-action="thread"]').click();
    assert.equal(await input.inputValue(), ""); assert.equal(await status.textContent(), "");
    assert.deepEqual(errors, []);
  });
}
