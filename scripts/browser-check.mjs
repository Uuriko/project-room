// Real browser + local HTTP service; all identities, messages, and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`authenticated ${label}: conversation, drafts, retries, reactions, search, source work, and revocation`, { timeout: 90000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-browser-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
    send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
    send(owner, T.MEMBER_ADDED, { memberId: "room-agent", displayName: "Room agent", kind: "agent", permissions: [] });
    const human = store.issueAccessKey("commons", "maya"), agent = store.issueAccessKey("commons", "room-agent");
    send(human, T.MESSAGE_POSTED, { messageId: "book-club", body: "Anyone up for a weekend book club?" });
    send(agent, T.MESSAGE_POSTED, { messageId: "book-reply", body: "A science-fiction pick could be fun. Which edition?", replyToId: "book-club" });
    send(owner, T.MESSAGE_POSTED, { messageId: "coffee", body: "The room is also a good place for a coffee break." });
    const server = createRoomServer({ store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser, page, other;
    const capture = async suffix => {
      mkdirSync("test-results", { recursive: true });
      // Capture from the top so fixed/sticky UI is not drawn halfway down a full-page image.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: `test-results/conversation-${label}${suffix}.png`, fullPage: true });
    };
    t.after(async () => {
      if (page && await page.locator("#main").isVisible().catch(() => false)) {
        await capture("-last").catch(() => {});
      }
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const otherContext = await browser.newContext({ viewport });
    page = await context.newPage(); other = await otherContext.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    other.on("pageerror", error => errors.push(error.message));
    const login = async (p, key) => {
      await p.goto(origin);
      await p.locator("#auth-panel").waitFor({ state: "visible" });
      assert.equal(await p.locator("#message-list").textContent(), "");
      await p.locator("#access-key").fill(key);
      await p.getByRole("button", { name: "Enter room", exact: true }).click();
      await p.locator("#main").waitFor({ state: "visible" });
    };
    await login(page, owner); await login(other, human);
    const input = page.locator("#message-input");
    await input.fill("Keep my room thought");
    await page.locator("#message-to-select").selectOption("maya");
    await input.focus();
    await input.evaluate(e => e.setSelectionRange(5, 7));
    await other.locator("#message-input").fill("A new room idea from Maya");
    await other.locator('#message-form button[type="submit"]').click();
    await page.getByText("A new room idea from Maya", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "Keep my room thought");
    assert.equal(await page.locator("#message-to-select").inputValue(), "maya");
    assert.deepEqual(await input.evaluate(e => [e === document.activeElement, e.selectionStart, e.selectionEnd]), [true, 5, 7]);

    // A reply opens a thread, and navigating away preserves each draft independently.
    await page.locator('#message-book-club [data-message-action="reply"]').click();
    await input.fill("Keep my thread thought");
    await page.locator("#message-to-select").selectOption("room-agent");
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "Keep my room thought");
    await page.locator('#message-book-club [data-message-action="thread"]').click();
    assert.equal(await input.inputValue(), "Keep my thread thought");
    assert.equal(await page.locator("#message-to-select").inputValue(), "room-agent");
    await page.locator('#message-book-reply [data-message-action="reply"]').click();
    await input.fill("The paperback edition sounds good.");

    // The first request commits but loses its response. The browser retries the same ID.
    const commandIds = []; let loseResponse = true;
    await page.route("**/api/rooms/commons/commands", async route => {
      const command = route.request().postDataJSON();
      commandIds.push(command.id);
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort("failed"); }
      else await route.continue();
    });
    await page.locator('#message-form button[type="submit"]').click();
    // One live-announcement owner per send result: the composer-local region owns the
    // failure; the page-level #status must NOT duplicate it (screen readers would announce twice).
    await page.waitForFunction(() => document.querySelector("#composer-status").textContent.includes("Draft kept") && !document.querySelector("#status").textContent.includes("Draft kept"));
    await page.locator("#thread-back").click();
    assert.equal(await input.inputValue(), "Keep my room thought");
    await page.locator('#message-book-club [data-message-action="thread"]').click();
    assert.equal(await input.inputValue(), "The paperback edition sounds good.");
    assert.match(await page.locator("#reply-context").textContent(), /Room agent/);
    await input.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector("#message-input").value === "");
    await page.unroute("**/api/rooms/commons/commands");
    assert.equal(commandIds.length, 2); assert.equal(commandIds[0], commandIds[1]);
    const posted = store.snapshot(owner, "commons").state.messages.filter(m => m.body === "The paperback edition sounds good.");
    assert.equal(posted.length, 1); assert.equal(posted[0].replyToId, "book-reply");
    assert.equal(posted[0].toMemberId, "room-agent");

    await page.locator("#thread-back").click();
    const heart = p => p.locator('#message-book-club [data-reaction="heart"]');
    await heart(page).click();
    await page.waitForFunction(() => document.querySelector('#message-book-club [data-reaction="heart"]').getAttribute("aria-pressed") === "true");
    const selectedBody = await page.locator('#message-book-club .message-content p').evaluate(e => {
      const range = document.createRange(); range.selectNodeContents(e);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    await heart(other).click();
    await page.waitForFunction(() => document.querySelector('#message-book-club [data-reaction="heart"]').getAttribute("aria-label").includes(", 2"));
    assert.equal(await page.evaluate(() => window.getSelection().toString()), selectedBody);
    await heart(page).click();
    await page.waitForFunction(() => document.querySelector('#message-book-club [data-reaction="heart"]').getAttribute("aria-pressed") === "false");
    assert.deepEqual(store.snapshot(owner, "commons").state.messages[0].reactions.heart, ["maya"]);

    // Unrelated live traffic retains the exact message DOM node and focused control.
    const focusedReply = page.locator('#message-book-club [data-message-action="reply"]');
    await focusedReply.focus();
    await focusedReply.evaluate(e => { window.retainedControl = e; });
    send(agent, T.MESSAGE_POSTED, { body: "Another topic, without a task." });
    await page.getByText("Another topic, without a task.", { exact: true }).waitFor();
    assert.equal(await focusedReply.evaluate(e => e === window.retainedControl && e === document.activeElement), true);

    // Search lands at the original reply, including when it was hidden in a thread.
    await page.locator("#message-search").fill("paperback edition");
    await page.locator(`#search-list [data-open-message="${posted[0].id}"]`).click();
    assert.equal(await page.locator("#thread-bar").isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), `message-${posted[0].id}`);
    await page.locator("#clear-search").click();
    await page.locator(`#message-${posted[0].id} [data-message-action="work"]`).click();
    await page.locator("#work-title-input").fill("Pick our first book");
    await page.locator("#work-done-input").fill("A shared reading choice with its original discussion.");
    await page.locator("#assignee-select").selectOption("maya");
    await page.locator("#verifier-select").selectOption("owner");
    await page.locator('#new-work-form button[type="submit"]').click();
    await page.locator("#new-work-form").waitFor({ state: "hidden" });
    const work = Object.values(store.snapshot(owner, "commons").state.workItems);
    assert.equal(work.length, 1); assert.equal(work[0].sourceMessageId, posted[0].id);
    await page.locator("#thread-back").click();
    await page.locator('#work-list [data-open-message]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), `message-${posted[0].id}`);

    // Literal markup is text, and long text still reflows at this viewport.
    send(human, T.MESSAGE_POSTED, { body: "<strong>Literal text</strong> " + "longword".repeat(35), replyToId: "book-club" });
    await page.getByText(/<strong>Literal text<\/strong>/).waitFor();
    assert.equal(await page.locator(".message-content p strong").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await capture("");

    // Reload warning is a best-effort guard, not persistent draft storage.
    await input.fill("Reload discards this unsent thought");
    let warned = false;
    page.once("dialog", async dialog => { warned = dialog.type() === "beforeunload"; await dialog.accept(); });
    await page.reload();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(warned, true); assert.equal(await input.inputValue(), "");

    // Revoking a session removes every private discussion and in-memory draft.
    await input.fill("Clear this private draft on revocation");
    await page.locator("#message-search").fill("paperback");
    const rotated = store.issueAccessKey("commons", "owner");
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-list").textContent(), "");
    assert.equal(await page.locator("#search-list").textContent(), "");
    assert.equal(await input.inputValue(), "");
    await page.locator("#access-key").fill(rotated);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(errors, []);
  });
}

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`return brief ${label}: rail entry, frozen-horizon paging, live current, explicit ack`, { timeout: 90000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "room-browser-rb-"));
    const store = new RoomStore(join(directory, "room.sqlite"));
    store.initialize(initialRoom());
    const owner = store.issueAccessKey("commons", "owner");
    const send = (key, type, data) => store.command(key, "commons", { id: crypto.randomUUID(), type, data });
    send(owner, T.MEMBER_ADDED, { memberId: "maya", displayName: "Maya", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
    const human = store.issueAccessKey("commons", "maya");
    for (let i = 1; i <= 55; i++) send(owner, T.MESSAGE_POSTED, { body: `catch-up note ${i}` });
    send(owner, T.WORK_PROPOSED, { workItemId: "w-brief", title: "Read the briefing", definitionOfDone: "Summary posted", accountableMemberId: "maya" });
    const server = createRoomServer({ store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser, page;
    t.after(async () => {
      if (page && await page.locator("#main").isVisible().catch(() => false)) {
        mkdirSync("test-results", { recursive: true });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })).catch(() => {});
        await page.screenshot({ path: `test-results/return-brief-${label}-last.png`, fullPage: true }).catch(() => {});
      }
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    page = await (await browser.newContext({ viewport, reducedMotion: "reduce" })).newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#access-key").fill(human);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });

    // The rail entry opens to live current sections and a frozen first page of history.
    const panel = page.locator("#return-brief-panel");
    await panel.locator("summary").click();
    await page.locator("#rb-history-list .rb-event").first().waitFor();
    await page.locator("#rb-attention-list", { hasText: "Read the briefing" }).waitFor();
    assert.match(await page.locator("#rb-current-boundary").textContent(), /as of event \d+/);
    assert.match(await page.locator("#rb-history-boundary").textContent(), /since marker 0 · through event \d+/);
    assert.match(await page.locator("#rb-attention-list").textContent(), /your step: accept/);
    assert.equal(await page.locator("#rb-history-list .rb-event").count(), 50); // bounded first page
    await page.locator("#rb-more-button").click();
    await page.waitForFunction(() => document.querySelectorAll("#rb-history-list .rb-event").length > 50);
    assert.equal(await page.locator("#rb-history-list .rb-event").count(), 59); // every event drillable
    assert.equal(await page.locator("#rb-more-button").isVisible(), false);
    mkdirSync("test-results", { recursive: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: `test-results/return-brief-${label}-open.png`, fullPage: true });

    // A late event stays out of the frozen history while current stays live on the next fetch.
    send(owner, T.MESSAGE_POSTED, { body: "arrived while reading" });
    await panel.evaluate(e => { e.open = false; }); await panel.locator("summary").click(); // reopen: fresh horizon
    await page.waitForFunction(() => document.querySelector("#rb-history-boundary").textContent.includes("through event 60"));
    assert.equal(await page.locator("#rb-history-list").textContent().then(t => t.includes("arrived while reading")), false); // still paged out
    await page.locator("#rb-more-button").click(); // the continuation keeps the SAME frozen horizon
    await page.waitForFunction(() => document.querySelector("#rb-history-list").textContent.includes("arrived while reading"));

    // The explicit ack acknowledges exactly H; reading never did.
    assert.equal(store.snapshot(human, "commons").cursor, 0);
    await page.locator("#rb-ack-button").click();
    await page.waitForFunction(() => document.querySelector("#rb-history-boundary").textContent.includes("nothing new"));
    assert.equal(store.snapshot(human, "commons").cursor, 60);
    await page.locator("#rb-attention-list", { hasText: "Read the briefing" }).waitFor(); // unresolved work survives catch-up
    assert.equal(await page.locator("#rb-ack-button").isDisabled(), true);
    // H+1 stays new: one more event after the ack is the only history item.
    send(owner, T.MESSAGE_POSTED, { body: "after the marker" });
    await panel.evaluate(e => { e.open = false; }); await panel.locator("summary").click();
    await page.waitForFunction(() => document.querySelectorAll("#rb-history-list .rb-event").length === 1);
    assert.match(await page.locator("#rb-history-list").textContent(), /after the marker/);
    assert.deepEqual(errors, []);
  });
}
