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
import { fillAccessKey } from "./auth-signin.mjs";
import { openSearch } from "./room-chrome.mjs";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["narrow", { width: 320, height: 780 }]]) {
  test(`composer ${label}: keyboard recovery, discussion errors, composition, and access cleanup`, { timeout: 60000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-composer-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
    send(T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: [] });
    // Consent-bound DMs: the owner addresses maya in this flow.
    store.dmConsents.request("commons", "owner", "maya", "browser test");
    store.dmConsents.decide("commons", "maya", "owner", "approve");
    send(T.MESSAGE_POSTED, { messageId: "topic", body: "Which book should we read?" });
    send(T.MESSAGE_POSTED, { messageId: "reply", body: "A short story collection?", replyToId: "topic" });
    send(T.MESSAGE_POSTED, { messageId: "ping", body: "Ping @Room owner" });
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
      await fillAccessKey(page, key);
      await page.getByRole("button", { name: "Enter room", exact: true }).click();
      await page.locator("#main").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#access-key").disabled);
    };
    await login(owner);
    const input = page.locator("#message-input"), status = page.locator("#composer-status");
    assert.match(await input.getAttribute("placeholder"), /Message #/);

    // @-mention autocomplete is a real listbox: rows are options, the textarea points at the active one.
    const mentionList = page.locator("#mention-list");
    assert.equal(await input.getAttribute("aria-expanded"), "false");
    assert.equal(await input.getAttribute("aria-autocomplete"), "list");
    await input.click();
    await page.keyboard.type("Hi @");
    await mentionList.waitFor({ state: "visible" });
    assert.equal(await mentionList.getAttribute("role"), "listbox");
    const options = mentionList.locator('[role="option"]');
    assert.ok(await options.count() >= 2, "an empty @ query lists every active member");
    assert.equal(await mentionList.locator("button, [aria-selected]:not([role='option'])").count(), 0, "aria-selected only on options, no nested buttons");
    assert.equal(await options.first().getAttribute("aria-selected"), "true");
    assert.equal(await options.first().getAttribute("id"), "mention-option-0");
    assert.equal(await input.getAttribute("aria-expanded"), "true");
    assert.equal(await input.getAttribute("aria-activedescendant"), "mention-option-0");
    await page.keyboard.press("ArrowDown");
    assert.equal(await input.getAttribute("aria-activedescendant"), "mention-option-1");
    assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
    assert.equal(await options.first().getAttribute("aria-selected"), "false");
    await page.keyboard.press("Escape");
    await mentionList.waitFor({ state: "hidden" });
    assert.equal(await input.getAttribute("aria-expanded"), "false");
    assert.equal(await input.getAttribute("aria-activedescendant"), null);
    assert.equal(await input.inputValue(), "Hi @");
    await page.keyboard.type("may");
    await mentionList.waitFor({ state: "visible" });
    assert.equal(await options.count(), 1);
    await mentionList.locator("[data-mention-id='maya']").click();
    await mentionList.waitFor({ state: "hidden" });
    assert.match(await input.inputValue(), /@Maya/);
    assert.equal(await page.locator("#message-to-select").inputValue(), "", "an inserted @mention is text-only and never selects a DM recipient");
    assert.equal(await page.evaluate(() => document.activeElement.id), "message-input");
    await input.fill("");
    const topic = page.locator('[data-message-record-id="topic"]');
    assert.equal(await topic.locator('.reactions button').count(), 0, "no unused reaction pills beneath messages");
    assert.equal(await topic.locator('.reaction-options').count(), 0, "no always-visible reaction picker");
    // Add Reaction lives in the ⋯ menu and opens a reaction sheet (long-press /
    // right-click open it too). Tapping a reaction toggles it and closes the sheet.
    const moreActions = topic.locator('summary[aria-label="More actions for this message"]');
    await moreActions.focus();
    await page.keyboard.press("Enter");
    await topic.locator('button[data-message-action="add-reaction"]').click();
    const sheet = page.locator("#reaction-sheet");
    await sheet.waitFor({ state: "visible" });
    send(T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "thinking", active: true });
    await topic.locator('.reactions [data-reaction="thinking"]').waitFor();
    assert.equal(await sheet.isVisible(), true, "live changes keep the open sheet");
    send(T.MESSAGE_REACTION_SET, { messageId: "topic", reaction: "thinking", active: false });
    await topic.locator('.reactions [data-reaction="thinking"]').waitFor({ state: "detached" });
    const sheetLike = sheet.locator('[data-reaction="like"]');
    assert.equal(await sheetLike.isVisible(), true);
    const sheetBounds = await sheet.boundingBox();
    assert.ok(sheetBounds.x >= 0 && sheetBounds.x + sheetBounds.width <= viewport.width, "sheet fits narrow and desktop screens");
    await sheetLike.click();
    await sheet.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector('[data-message-record-id="topic"] [data-reaction="like"]').getAttribute("aria-pressed") === "true");

    assert.equal(await topic.locator('.reactions button').count(), 1, "only the used reaction remains visible");
    assert.equal(await page.evaluate(() => document.activeElement.closest("li.message")?.dataset.messageRecordId), "topic", "closing the sheet returns focus to the message");
    const like = topic.locator('[data-reaction="like"]');

    // Error toasts persist until dismissed and can be selected/copied; successes still auto-clear.
    await page.route("**/api/rooms/commons/commands", route => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Reaction store unavailable" } })
    }));
    const toast = page.locator("#status");
    await like.click();
    await page.waitForFunction(() => document.querySelector("#status").classList.contains("error"));
    assert.match(await toast.locator(".status-text").textContent(), /Reaction store unavailable/);
    assert.equal(await toast.getAttribute("role"), "alert");
    assert.equal(await toast.getAttribute("aria-live"), "assertive");
    assert.deepEqual(await toast.evaluate(node => [getComputedStyle(node).pointerEvents, getComputedStyle(node).userSelect]), ["auto", "text"]);
    const dismiss = toast.getByRole("button", { name: "Dismiss error" });
    assert.equal(await dismiss.isVisible(), true);
    assert.equal(await toast.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node.querySelector(".status-text")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); const text = selection.toString(); selection.removeAllRanges(); return text; }).then(t => /Reaction store unavailable/.test(t)), true, "error text is selectable");
    await dismiss.click();
    assert.equal(await toast.textContent(), "");
    assert.equal(await toast.evaluate(node => node.classList.contains("visible")), false);
    assert.equal(await toast.getAttribute("role"), "status");
    await page.unroute("**/api/rooms/commons/commands");
    await page.locator('[data-message-record-id="topic"] button[data-reaction="like"]').click();
    // A cleared reaction detaches its chip (only used reactions stay visible),
    // so wait for detachment rather than an aria-pressed=false state that the
    // new UI never renders.
    await topic.locator('button[data-reaction="like"]').waitFor({ state: "detached" });
    await openSearch(page);
    await page.locator("#search-mentions").click();
    assert.equal(await page.locator("#search-mentions").getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#search-results").textContent(), /Ping @Room owner/);
    await page.locator("#clear-search").click();
    assert.equal(await page.locator("#search-results").isHidden(), true);
    assert.equal(await page.locator("#search-mentions").getAttribute("aria-pressed"), "false");
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    assert.match(await input.getAttribute("placeholder"), /Reply in thread/);
    await page.locator("#thread-back").click();
    assert.match(await input.getAttribute("placeholder"), /Message #/);
    assert.equal(await page.locator("#composer-options").count(), 0);
    assert.equal(await page.locator("#remember-drafts").count(), 0);
    const waitForFailure = () => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
    const waitForSaved = () => page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#message-input").value === "");

    await input.fill("A separate room draft");
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    await page.locator('[data-message-record-id="reply"] [data-message-action="reply"]').click();
    await page.locator("#message-to-select").selectOption("maya", { force: true });
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
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
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
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "A separate room draft");
    const stored = await page.evaluate(() => sessionStorage.getItem("project-room:drafts:v3"));
    assert.match(stored, /A separate room draft/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("project-room:drafts:v2")), null);

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
    await page.locator("#topbar-search-toggle").click();
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
    await page.keyboard.press("Shift+Enter");
    assert.equal(await input.inputValue(), "検討中の文章\n", "Shift+Enter inserts a line");
    await page.keyboard.press("Enter");
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
    await page.locator('[data-message-record-id="topic"] [data-message-action="thread"]').click();
    assert.equal(await input.inputValue(), ""); assert.equal(await status.textContent(), "");
    assert.deepEqual(errors, []);
  });
}
