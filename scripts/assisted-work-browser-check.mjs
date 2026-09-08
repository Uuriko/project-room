// Real browser commands against disposable loopback rooms only. No external agent runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const [label, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`assisted work ${label}: scope conflict, explicit release, exact retry and quiet catch-up`, { timeout: 90000 }, async t => {
    const fixture = createAcceptanceFixture();
    const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
    const externalRequests = [], errors = [], commands = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) {
        externalRequests.push(route.request().url());
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    context.on("page", page => {
      page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms/commons/commands") commands.push(request.postDataJSON());
      });
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator("#access-key").fill(fixture.keys.owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const snapshot = () => fixture.store.snapshot(fixture.keys.owner, "commons");
    const baseline = snapshot();
    const item = id => snapshot().state.workItems[id];
    const card = (target, id) => target.locator(`[data-work-record-id="${id}"]`);
    const isOpen = selector => page.locator(selector).evaluate(node => node.open);
    const capture = async (target, name) => {
      assert.equal(await target.locator("#main").isVisible(), true, "screenshots are signed-in views only");
      assert.equal(await target.locator("#auth-panel").isVisible(), false, "never capture a member-key entry view");
      await target.waitForFunction(() => !document.querySelector("#status").classList.contains("visible"));
      mkdirSync("test-results", { recursive: true });
      await target.screenshot({ path: `test-results/assisted-work-${label}-${name}.png`, fullPage: true });
    };
    const saveAction = async (target, status = 201) => {
      const [response] = await Promise.all([
        target.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/rooms/commons/commands"),
        target.locator('#action-form button[type="submit"]').click()
      ]);
      assert.equal(response.status(), status);
      if (status === 201) await target.locator("#action-dialog").waitFor({ state: "hidden" });
      return response.json();
    };
    assert.equal(await isOpen("#return-brief-panel"), false);
    assert.equal(await isOpen("#rb-history-section"), false);
    assert.equal(await isOpen("#rb-involving-section"), false);
    await page.locator("#message-input").fill("Keep my draft while I move around the room.");
    await page.locator('[data-room-section="work"]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "work-title");
    await page.locator('[data-room-section="catch-up"]').click();
    assert.equal(await isOpen("#return-brief-panel"), true);
    assert.equal(await page.locator("#message-input").inputValue(), "Keep my draft while I move around the room.");
    await page.locator("#return-brief-panel > summary").click();
    await page.locator('[data-room-section="chat"]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "conversation-title");
    await page.locator("#message-input").fill("");

    // The owner explicitly proposes and accepts both outcomes through the UI.
    const workIds = [];
    for (const title of ["First scoped change", "Second overlapping change"]) {
      await page.locator("#new-work-button").click();
      await page.locator("#work-title-input").fill(title);
      await page.locator("#work-done-input").fill("Post a versioned result after separately authorized external work.");
      await page.locator("#work-options > summary").click();
      await page.locator("#work-mode-select").selectOption("write");
      await page.locator("#assignee-select").selectOption("owner");
      await page.locator("#require-verification").uncheck();
      await page.locator("#require-decision").uncheck();
      await page.locator('#new-work-form button[type="submit"]').click();
      await page.locator("#new-work-form").waitFor({ state: "hidden" });
      const matches = Object.values(snapshot().state.workItems).filter(work => work.title === title);
      assert.equal(matches.length, 1);
      const id = matches[0].id;
      workIds.push(id);
      assert.equal(item(id).state, "proposed");
      await card(page, id).locator('[data-action="accept"]').click();
      await saveAction(page);
      assert.equal(item(id).state, "accepted");
      assert.equal(item(id).mode, "write");
      assert.equal(item(id).claim, null);
      await card(page, id).locator('[data-next-step="claim"]').waitFor();
      assert.equal(await card(page, id).locator(".state").textContent(), "Scope needed");
      assert.equal(await card(page, id).locator('[data-action="start"]').count(), 0, "write scope is required before the Start control appears");
    }
    const [first, second] = workIds;
    const scope = { repository: "test/project-room", ref: "assisted-work-test", expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const fillScope = async paths => {
      for (const [name, value] of Object.entries({ ...scope, paths })) await page.locator(`#action-fields [name="${name}"]`).fill(value);
    };
    await card(page, first).locator('[data-action="claim"]').click();
    await fillScope("src/**");
    await saveAction(page);
    assert.equal(item(first).claim.status, "active");
    assert.deepEqual(item(first).claim.paths, ["src/**"]);
    assert.equal(item(first).state, "accepted", "recording scope never starts external work");
    assert.equal(item(first).receipt, null);

    // The actual server rejects overlapping scope; the rejected command records nothing.
    await card(page, second).locator('[data-action="claim"]').click();
    await fillScope("src/room.js");
    const beforeConflict = snapshot();
    const conflict = await saveAction(page, 409);
    assert.equal(conflict.error.code, "claim_conflict");
    await page.waitForFunction(() => document.querySelector("#action-error").textContent.includes("reserved") && !document.querySelector('#action-form button[type="submit"]').disabled);
    assert.equal(await page.locator("#action-dialog").isVisible(), true);
    assert.match(await page.locator("#action-error").textContent(), /no new claim was saved/i);
    assert.equal(snapshot().sequence, beforeConflict.sequence);
    assert.deepEqual(item(second), beforeConflict.state.workItems[second]);
    for (const [name, value] of Object.entries({ ...scope, paths: "src/room.js" })) assert.equal(await page.locator(`#action-fields [name="${name}"]`).inputValue(), value);
    const attempts = () => commands.filter(command => command.type === T.CLAIM_ACQUIRED && command.data.workItemId === second);
    assert.equal(attempts().length, 1);
    await capture(page, "conflict-kept");

    // A second tab releases the first reservation while the rejected form stays intact.
    const releaser = await context.newPage();
    await releaser.goto(origin);
    await releaser.locator("#main").waitFor({ state: "visible" });
    const firstCard = card(releaser, first);
    assert.equal(await firstCard.locator(".work-details").evaluate(node => node.open), false);
    await firstCard.locator(".work-details > summary").click();
    assert.equal(await firstCard.locator(".claim").evaluate(node => node.open), false);
    await firstCard.locator(".claim > summary").click();
    assert.match(await firstCard.locator(".claim").textContent(), /Room owner \(owner\)/);
    await firstCard.getByRole("button", { name: "Release scope", exact: true }).click();
    assert.equal(await releaser.locator("#action-title").textContent(), "Release this scope?");
    assert.match(await releaser.locator("#action-fields").textContent(), /does not stop an outside agent/);
    assert.equal(item(first).claim.status, "active", "opening a confirmation does not release scope");
    await releaser.locator("#cancel-action").click();
    await releaser.waitForFunction(id => document.activeElement?.dataset.focusKey === `work-action:${id}:release`, first);
    assert.equal(item(first).claim.status, "active", "cancel does not release scope");
    await firstCard.getByRole("button", { name: "Release scope", exact: true }).click();
    await capture(releaser, "release-confirmation");
    await saveAction(releaser);
    assert.equal(item(first).claim.status, "released");
    assert.equal(item(first).state, "accepted");
    assert.equal(item(first).receipt, null);
    await releaser.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, first);
    await firstCard.locator('[data-next-step="claim"]').waitFor();
    assert.equal(await firstCard.locator(".state").textContent(), "Scope needed");
    assert.equal(await firstCard.locator('[data-action="start"]').count(), 0, "released scope must not advertise a Start action");
    assert.equal(await firstCard.locator('[data-action="release"]').count(), 0);

    // Retrying the unchanged rejected form uses the same command ID and data.
    for (const [name, value] of Object.entries({ ...scope, paths: "src/room.js" })) assert.equal(await page.locator(`#action-fields [name="${name}"]`).inputValue(), value);
    await saveAction(page);
    assert.equal(attempts().length, 2);
    assert.deepEqual(attempts()[1], attempts()[0], "conflict retry preserves the complete original command");
    assert.equal(item(second).claim.status, "active");
    assert.deepEqual(item(second).claim.paths, ["src/room.js"]);
    assert.equal(item(second).state, "accepted");
    assert.equal(item(second).receipt, null);
    await releaser.close();

    assert.equal(await isOpen("#return-brief-panel"), false, "workflow actions never expand catch-up automatically");
    await capture(page, "quiet-work");
    await page.locator("#message-input").fill("Keep this private unsent draft while I review changes.");
    await page.locator("#return-brief-panel > summary").focus();
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/rooms/commons/return-brief"),
      page.keyboard.press("Enter")
    ]);
    await page.waitForFunction(() => document.querySelector("#summary-grid").textContent && !document.querySelector("#rb-refresh-button").disabled);
    assert.equal(await isOpen("#return-brief-panel"), true);
    assert.equal(await isOpen("#rb-history-section"), false);
    assert.equal(await isOpen("#rb-involving-section"), false);
    assert.equal(await page.locator("#rb-history-list").isVisible(), false);
    assert.equal(await page.locator("#rb-involving-list").isVisible(), false);
    assert.equal(await page.locator("#rb-attention-list [data-open-work]").count(), 2);
    assert.match(await page.locator("#summary-grid").textContent(), /2 to act on/);
    for (const selector of ["#rb-history-section", "#rb-involving-section"]) {
      await page.locator(`${selector} > summary`).focus();
      await page.keyboard.press("Space");
      assert.equal(await isOpen(selector), true, "nested disclosure opens by keyboard");
      assert.ok((await page.locator(`${selector} > summary`).boundingBox()).height >= 44, "disclosure has a usable touch target");
    }
    const recorded = fixture.store.eventsAfter(fixture.keys.owner, "commons", baseline.sequence, 100).events;
    assert.deepEqual(recorded.map(({ event }) => event.type), [T.WORK_PROPOSED, T.WORK_ACCEPTED, T.WORK_PROPOSED, T.WORK_ACCEPTED, T.CLAIM_ACQUIRED, T.CLAIM_RELEASED, T.CLAIM_ACQUIRED]);
    assert.equal(recorded.some(({ event }) => [T.WORK_STARTED, T.WORK_COMPLETED].includes(event.type)), false, "coordination never claims automatic execution or completion");
    assert.equal(snapshot().cursor, baseline.cursor, "reading and disclosing a catch-up never acknowledges it");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture(page, "catch-up-disclosures");
    await page.locator(`#rb-history-list [data-open-work="${second}"]`).last().click();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.workRecordId), second);
    assert.equal(await page.locator("#message-input").inputValue(), "Keep this private unsent draft while I review changes.");
    const normalFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), normalFontSize * 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "200% text must not cause horizontal overflow");
    await capture(page, "enlarged-text");
    assert.deepEqual(externalRequests, [], "no browser request leaves the disposable local room");
    assert.deepEqual(errors, []);
  });
}
