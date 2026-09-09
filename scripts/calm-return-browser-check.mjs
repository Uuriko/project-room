// Simulated human return journeys, not retention evidence or real user feedback.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`calm return ${label}: current needs, personal reminders, frozen history and clock-only changes`, { timeout: 90000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser, now = Date.now(); f.store.now = () => now;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    const snapshot = () => f.store.snapshot(f.keys.owner, "commons");
    const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
    const mutate = (id, type, data = {}) => send(type, { workItemId: id, expectedRevision: snapshot().state.workItems[id].revision, ...data });
    for (let n = 0; n < 8; n++) send(T.WORK_PROPOSED, {
      workItemId: `return-${n}`, title: ["Review Friday's agenda", "Update the project notes", "Choose the next experiment", "Check the shared result", "Answer a project question", "Outline the next handoff", "Review the invitation", "Continue the research"][n],
      definitionOfDone: "A synthetic, local test result only.", accountableMemberId: "owner",
      independentVerificationRequired: false, ownerDecisionRequired: false, mode: [1, 7].includes(n) ? "write" : "read"
    });
    f.store.reminders.mutate(f.keys.owner, "commons", {
      requestId: crypto.randomUUID(), workItemId: "return-0", expectedRevision: 0, action: "schedule", dueAt: now + 60000
    });
    now += 120000;
    for (const n of [1, 7]) {
      const id = `return-${n}`;
      mutate(id, T.WORK_ACCEPTED);
      mutate(id, T.CLAIM_ACQUIRED, { repository: "fictional/calm-return", ref: "fixture", paths: [`notes/${n}.md`], expiresAt: new Date(now + 600000).toISOString() });
    }
    mutate("return-7", T.WORK_STARTED);
    for (let n = 0; n < 52; n++) send(T.MESSAGE_POSTED, { messageId: `context-${n}`, body: `Synthetic context update ${n + 1}.` });
    const initial = snapshot();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    const external = [], errors = [], writes = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() !== "GET" && request.url().includes("/api/rooms/")) writes.push(new URL(request.url()).pathname); });
    await page.clock.install({ time: now });
    await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const panel = page.locator("#return-brief-panel"), summary = panel.locator(":scope > summary");
    const attention = id => page.locator(`#rb-attention-list [data-open-work="${id}"]`);
    const card = id => page.locator(`[data-work-record-id="${id}"]`);
    const ready = () => page.waitForFunction(() => Boolean(document.querySelector("#rb-ack-button").dataset.horizon) && !document.querySelector("#rb-ack-button").disabled);
    const capture = async name => {
      assert.equal(await page.locator("#auth-panel").isVisible(), false);
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({ path: `test-results/calm-return-${label}-${name}.png` });
    };
    await ready(); await page.waitForFunction(() => document.querySelector("#reminder-count").textContent === "1 reminder");
    now += 6000; await page.clock.fastForward(6000); // Let the normal sign-in notice clear.
    assert.equal(await panel.evaluate(node => node.open), true, "catch-up opens on first visit when work needs you");
    assert.equal(await page.locator("#return-brief-panel").count(), 1);
    assert.equal(await page.locator("#caught-up-button").count(), 0);
    assert.match(await page.locator("#catchup-count").textContent(), /^7 need you/);
    assert.equal(await panel.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".conversation-panel")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await page.evaluate(() => scrollTo(0, 0)); await capture("open-on-return");
    assert.equal(await summary.evaluate(node => node.getBoundingClientRect().bottom < innerHeight), true);
    await ready();
    await page.waitForFunction(() => document.querySelector("#return-brief-panel").getAttribute("aria-busy") === "false");
    const horizon = Number(await page.locator("#rb-ack-button").getAttribute("data-horizon"));
    assert.ok(horizon > 0, 'the opened brief owns a populated history horizon');
    assert.equal(await page.locator("#rb-attention-list a").count(), 5);
    assert.equal(await page.locator("#rb-history-section").evaluate(node => node.open), false);
    assert.equal(await page.locator("#rb-involving-section").evaluate(node => node.open), false);
    assert.equal(await page.locator("#rb-more-button").getAttribute("hidden"), null, "history has another page even while its disclosure is closed");
    assert.match(await page.locator("#rb-ack-note").textContent(), new RegExp(`Marks all ${horizon} updates read`));
    assert.equal(await page.locator('#rb-involving-list [data-open-work="return-0"]').count(), 0, "needs and ongoing do not duplicate the same task");
    assert.equal(await page.locator("#reminder-due li").count(), 1, "a personal reminder is a separate reason, not an extra task count");
    await page.evaluate(() => scrollTo(0, 0)); await capture("expanded");
    await page.locator("#rb-show-all").click(); assert.equal(await page.locator("#rb-attention-list a").count(), 7);
    await page.locator("#rb-show-all").click(); assert.equal(await page.locator("#rb-attention-list a").count(), 5);
    assert.equal(await page.locator("#rb-show-all").evaluate(node => node === document.activeElement), true);

    await page.locator("#message-input").fill("A draft to keep while catching up.");
    await page.locator("#composer-options > summary").click();
    await page.locator("#message-to-select").selectOption("guest");
    await page.locator("#message-input").evaluate(node => node.setSelectionRange(2, 9));
    await attention("return-1").click();
    assert.equal(await card("return-1").locator(".work-details").evaluate(node => node.open), true);
    assert.equal(await card("return-1").evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.locator("#message-input").evaluate(node => [node.value, node.selectionStart, node.selectionEnd]), ["A draft to keep while catching up.", 2, 9]);
    assert.equal(await page.locator("#message-to-select").inputValue(), "guest");
    assert.deepEqual(snapshot(), initial); assert.deepEqual(writes, []);

    // No event arrives when permission scope expires. Both places must agree,
    // without shifting the focused second item to the first or marking anything read.
    await attention("return-1").focus();
    now += 600100; await page.clock.fastForward(600100);
    await page.waitForFunction(() => document.querySelector("#catchup-count").textContent.startsWith("8 need you"));
    assert.match(await attention("return-1").locator("..").textContent(), /Confirm permission and reserve write scope/);
    assert.equal(await attention("return-1").evaluate(node => node === document.activeElement), true);
    assert.equal(await card("return-1").locator('[data-action="start"]').count(), 0);
    assert.equal(await card("return-1").locator('[data-action="claim"]').count(), 1);
    assert.match(await card("return-1").locator(".claim > summary").textContent(), /expired/);
    assert.equal(await card("return-1").locator(".work-details").evaluate(node => node.open), true);
    assert.equal(Number(await page.locator("#rb-ack-button").getAttribute("data-horizon")), horizon);
    assert.deepEqual(snapshot(), initial); assert.deepEqual(writes, []);

    mutate("return-0", T.WORK_ACCEPTED);
    mutate("return-0", T.WORK_COMPLETED, { summary: "Synthetic agenda", producerId: "owner", evidenceVersion: "v1", evidenceUrl: "https://example.invalid/fixture", nextAction: "No further gates" });
    await attention("return-0").waitFor({ state: "detached" });
    mutate("return-0", T.WORK_BLOCKED, { reason: "One question remains", nextAction: "Revise the agenda" });
    await attention("return-0").waitFor();
    assert.equal(Number(await page.locator("#rb-ack-button").getAttribute("data-horizon")), horizon);
    assert.match(await page.locator("#rb-status").textContent(), /New changes available/);
    assert.equal(snapshot().cursor, 0);

    // A failed catch-up fetch cannot hide known current work or permit stale ack.
    let failBrief = true;
    await page.route("**/api/rooms/commons/return-brief", route => failBrief
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Synthetic unavailable" } }) })
      : route.continue());
    await page.locator("#rb-refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#rb-status").textContent.includes("could not load"));
    assert.equal(await page.locator("#rb-attention-list a").count(), 5);
    assert.equal(await page.locator("#rb-ack-button").isDisabled(), true);
    assert.equal(snapshot().cursor, 0); assert.deepEqual(writes, []);
    assert.equal(await page.locator("#message-input").inputValue(), "A draft to keep while catching up.");
    failBrief = false; await page.locator("#rb-refresh-button").click(); await ready();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; scrollTo(0, 0); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    assert.equal(await summary.evaluate(node => getComputedStyle(node).fontSize), "32px");
    assert.equal(await page.locator("#rb-show-all").evaluate(node => getComputedStyle(node).fontSize), "28px");
    await capture("large-text");
    await page.locator("#rb-ack-button").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#rb-ack-button").evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    }), true, "large-text acknowledgement remains reachable without horizontal scrolling");
    await capture("large-text-controls"); await page.evaluate(() => document.documentElement.style.fontSize = "");
    page.once("dialog", dialog => dialog.accept()); // Explicit synthetic consent to discard our draft.
    await page.locator("#signout-button").click(); await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#catchup-count").textContent(), "");
    assert.equal(await page.locator("#rb-attention-list").textContent(), "");
    assert.equal(await page.locator("#reminder-count").textContent(), "");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
}
