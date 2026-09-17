import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const touch of [false, true]) {
  const label = touch ? "touch" : "desktop";
  test(`quiet design ${label}: disclosure, keyboard sending, modal focus and reflow`, { timeout: 60000 }, async t => {
    const fixture = createAcceptanceFixture();
    const server = createRoomServer({ store: fixture.store, streamInterval: 60 });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#access-key").fill(fixture.keys.owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("#access-key").disabled);
    for (const id of ["people-panel", "composer-options", "work-options"]) {
      assert.equal(await page.locator("#" + id).evaluate(e => e.open), false, id + " starts quiet");
    }
    assert.equal(await page.locator(".work-details").first().evaluate(e => e.open), false);
    // C3 rest state, before any screenshot (Chromium 151 captures reset touch
    // emulation): quiet on pointer devices, always visible on touch.
    const restAction = page.locator('[data-message-record-id="test-request"] [data-message-action="work"]');
    await restAction.waitFor({ state: "attached" });
    const restOpacity = await restAction.evaluate(e => getComputedStyle(e).opacity);
    assert.equal(restOpacity, touch ? "1" : "0", touch ? "touch: secondary actions always visible" : "desktop: secondary actions quiet at rest");
    mkdirSync("test-results", { recursive: true });
    const input = page.locator("#message-input");
    assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), touch);
    assert.equal(await input.getAttribute("enterkeyhint"), touch ? "enter" : "send");
    const before = fixture.store.snapshot(fixture.keys.owner, "commons").state.messages.length;
    await input.fill("   ");
    if (!touch) await input.press("Enter");
    assert.equal(fixture.store.snapshot(fixture.keys.owner, "commons").state.messages.length, before);
    await input.fill("First line");
    await input.press(touch ? "Enter" : "Shift+Enter");
    await input.pressSequentially("Second line");
    assert.equal(await input.inputValue(), "First line\nSecond line");
    assert.equal(fixture.store.snapshot(fixture.keys.owner, "commons").state.messages.length, before);
    if (touch) await page.getByRole("button", { name: "Send", exact: true }).click();
    else await input.press("Enter");
    await page.waitForFunction(() => document.querySelector("#message-input").value === "" && !document.querySelector("#message-input").disabled);
    const messages = fixture.store.snapshot(fixture.keys.owner, "commons").state.messages;
    assert.equal(messages.length, before + 1);
    assert.equal(messages.at(-1).body, "First line\nSecond line");
    if (!touch) assert.equal(await input.evaluate(e => document.activeElement === e), true);
    // Chromium 151 screenshot capture resets touch emulation. Exercise the
    // real emulated keyboard before captures; narrow width alone is not mobile.
    await page.screenshot({ path: `test-results/quiet-${label}-room.png`, fullPage: true });

    // Review settings are secondary, but their defaults and required reviewer are visible.
    await page.locator("#new-work-button").click();
    assert.equal(await page.locator("#work-dialog").evaluate(e => e.matches(":modal")), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "work-title-input");
    assert.equal(await page.locator("#work-options").evaluate(e => e.open), false);
    assert.equal(await page.locator("#verifier-select").isVisible(), true);
    assert.match(await page.locator("#work-options-summary").textContent(), /Review \+ approval · read only/);
    await page.locator("#work-title-input").fill("Prepare the agenda");
    await page.locator("#work-done-input").fill("An agenda with an owner and a source for each decision.");
    await page.locator("#assignee-select").selectOption("producer");
    await page.screenshot({ path: `test-results/quiet-${label}-new-work.png` });
    await page.locator("#work-options > summary").click();
    await page.locator("#require-verification").uncheck();
    await page.locator("#require-decision").uncheck();
    assert.equal(await page.locator("#verifier-select").isVisible(), false);
    assert.equal(await page.locator("#verifier-select").isDisabled(), true);
    assert.match(await page.locator("#work-options-summary").textContent(), /Evidence only/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement.id === "new-work-button");
    await page.locator("#new-work-button").click();
    assert.equal(await page.locator("#require-verification").isChecked(), true);
    assert.equal(await page.locator("#require-decision").isChecked(), true);
    await page.locator("#cancel-work-button").click();

    const card = page.locator('[data-work-record-id="test-handoff"]');
    // C2: the primary work line comes first and expanded details never compete with it.
    const nextStep = card.locator(".work-next-step");
    await nextStep.waitFor({ state: "visible" });
    assert.equal(await card.locator(".work-details").evaluate(e => e.open), false, "details stay closed while the Next line is visible");
    assert.equal(await card.evaluate(article => {
      const order = [".work-next-step", ".work-details", ".work-actions"].map(sel => [...article.children].findIndex(el => el.matches(sel)));
      return order[0] > -1 && order[0] < order[1] && order[1] < order[2];
    }), true, "Next line precedes details and secondary actions");
    const nextY = await nextStep.evaluate(e => e.getBoundingClientRect().y);
    await card.locator(".work-details > summary").click();
    await card.locator(".work-details > summary").focus();
    assert.equal(await nextStep.isVisible(), true, "Next line survives expanded details");
    assert.equal(await nextStep.evaluate(e => e.getBoundingClientRect().y), nextY, "expanded details do not move the primary line");
    fixture.store.command(fixture.keys.owner, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "quiet-update", body: "An unrelated update." } });
    await page.locator('[data-message-record-id="quiet-update"]').waitFor();
    assert.equal(await card.locator(".work-details").evaluate(e => e.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.focusKey), "work-details:test-handoff");
    if (!touch) {
      const reveal = page.locator('[data-message-record-id="quiet-update"] [data-message-action="work"]');
      await reveal.evaluate(e => e.focus());
      assert.equal(await reveal.evaluate(e => document.activeElement === e), true, "keyboard focus lands on the action");
      assert.equal(await reveal.evaluate(e => getComputedStyle(e).opacity), "1", "keyboard focus reveals the action");
      await reveal.evaluate(e => e.blur());
    }
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "doubled text reflows");
    await input.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/quiet-${label}-large-text-viewport.png` });
    await page.screenshot({ path: `test-results/quiet-${label}-large-text.png`, fullPage: true });
    if (await page.locator("#session-menu-button").isVisible()) await page.locator("#session-menu-button").click(); await page.locator("#signout-button").click();
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#work-dialog").evaluate(e => e.open), false);
    for (const id of ["people-panel", "composer-options", "work-options"]) assert.equal(await page.locator("#" + id).evaluate(e => e.open), false);
    assert.deepEqual(errors, []);
  });
}
