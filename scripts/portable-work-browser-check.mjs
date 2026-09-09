// Simulated human journeys in real browsers against isolated, synthetic rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

for (const mobile of [false, true]) {
  const label = mobile ? "mobile" : "desktop";
  test(`portable work ${label}: selected export, copy fallback, stale return and lost-response retry`, { timeout: 90000 }, async t => {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 60 });
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
    const external = [], errors = [], writes = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const touchEmulation = mobile ? await context.newCDPSession(page) : null;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/commands")) writes.push(request.postDataJSON()); });
    await page.goto(origin); await page.locator("#access-key").fill(f.keys.owner);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    const snapshot = () => f.store.snapshot(f.keys.owner, "commons");
    const before = snapshot();
    const card = page.locator('[data-work-record-id="test-handoff"]');
    const open = async (result = false) => {
      if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
      await card.getByRole("button", { name: result ? "Paste AI draft" : "Use my AI", exact: true }).click();
      await page.locator("#portable-dialog").waitFor({ state: "visible" });
    };
    const screenshot = async name => {
      assert.equal(await page.locator("#auth-panel").isVisible(), false);
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({ path: `test-results/portable-${label}-${name}.png`, fullPage: false });
      // Chromium 151 screenshot capture resets touch emulation. Restore it before
      // testing touch keyboard behavior; viewport width alone is not that proof.
      if (touchEmulation) await touchEmulation.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    };
    const reference = text => text.split("\n").find(line => line.startsWith("ROOM-RETURN "));
    await page.locator("#message-input").fill("unsent-private-sentinel");
    assert.equal(await card.getByRole("button", { name: "Use my AI", exact: true }).isVisible(), false, "advanced actions start inside Details");
    await open();
    const initial = await page.locator("#packet-preview").inputValue();
    for (const absent of ["unsent-private-sentinel", "Disposable test room. Try a reply", "Please prepare an agenda", f.keys.owner]) assert.equal(initial.includes(absent), false);
    await page.locator("#portable-source").check();
    assert.match(await page.locator("#packet-preview").inputValue(), /Please prepare an agenda/);
    await page.locator("#portable-source").uncheck();
    await page.locator("#packet-copy").click();
    await page.getByText("Copied. Paste into your AI.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), initial);
    await screenshot("packet");
    await page.evaluate(() => { window.originalCopy = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
    await page.locator("#packet-copy").click();
    await page.getByText("Select the prompt and copy it manually.", { exact: true }).waitFor();
    assert.equal(await page.locator("#packet-preview").evaluate(node => node.selectionEnd - node.selectionStart), initial.length);
    assert.deepEqual(snapshot(), before, "preview/copy did not change Room state");

    // The operating system can finish a copy after its dialog has closed.
    // Do not let a reopened dialog race that pending write, or inherit its status.
    for (const outcome of ["resolve", "reject"]) {
      await page.evaluate(() => {
        window.copyCalls = 0;
        navigator.clipboard.writeText = () => {
          window.copyCalls++;
          return new Promise((resolve, reject) => { window.settleCopy = { resolve, reject }; });
        };
      });
      await page.locator("#packet-copy").click();
      await page.locator("#portable-close").click(); await open();
      assert.equal(await page.locator("#packet-preview").evaluate(node => node.scrollTop), 0, "a new prompt starts at its task, not the old scroll position");
      assert.equal(await page.locator("#packet-copy").isDisabled(), true, "reopening cannot overlap an issued clipboard write");
      assert.equal(await page.locator("#packet-copy").textContent(), "Copying…");
      await page.locator("#packet-copy").dispatchEvent("click");
      assert.equal(await page.evaluate(() => window.copyCalls), 1, "handler also fences duplicate copies");
      if (outcome === "resolve") await screenshot("copy-pending");
      await page.evaluate(outcome => window.settleCopy[outcome](), outcome);
      await page.waitForFunction(() => !document.getElementById("packet-copy").disabled);
      assert.equal(await page.locator("#portable-status").textContent(), "", "retired copy cannot report on a new prompt");
      assert.equal(await page.locator("#packet-copy").textContent(), "Copy");
    }
    for (const outcome of ["resolve", "reject"]) {
      await page.locator("#packet-copy").click();
      await page.locator("#portable-add-result").click();
      await page.locator("#portable-result").fill("Answer without its return line");
      await page.locator("#portable-submit").click();
      const returnError = await page.locator("#portable-status").textContent();
      assert.match(returnError, /Include the ROOM-RETURN line/);
      await page.evaluate(outcome => window.settleCopy[outcome](), outcome);
      await page.waitForFunction(() => !document.getElementById("packet-copy").disabled);
      assert.equal(await page.locator("#portable-status").textContent(), returnError, "copy settlement cannot replace return feedback");
      assert.equal(await page.locator("#portable-form").isVisible(), true);
      await page.locator("#portable-result").fill("");
      await page.locator("#portable-close").click(); await open();
    }
    await page.evaluate(() => { navigator.clipboard.writeText = window.originalCopy; });
    await page.locator("#packet-copy").click();
    await page.getByText("Copied. Paste into your AI.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.locator("#packet-preview").inputValue());
    assert.deepEqual(snapshot(), before, "copy recovery remains read-only");

    await page.locator("#portable-add-result").click();
    const answer = reference(initial) + "\n\nProposed agenda: owner confirms priorities, team reviews blockers. No external tests performed.";
    await page.locator("#portable-result").fill(answer);
    await page.locator("#portable-close").click();
    await open(true);
    assert.equal(await page.locator("#portable-result").inputValue(), answer, "Close preserves the draft in this session");
    f.store.command(f.keys.producer, "commons", { id: "accept-during-handoff", type: T.WORK_ACCEPTED, data: { workItemId: "test-handoff", expectedRevision: 0 } });
    const changedWork = snapshot().state.workItems;
    if (mobile) {
      await page.locator("#portable-result").press("Enter");
      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
      assert.equal(writes.length, 0, "touch Return adds a line, not a message");
      await page.locator("#portable-submit").click();
    } else await page.locator("#portable-result").press("Enter");
    await page.locator("#portable-older-label").waitFor({ state: "visible" });
    assert.match(await page.locator("#portable-status").textContent(), /Stale handoff/);
    assert.equal(snapshot().state.messages.filter(m => m.proposal).length, 0);
    assert.match(await page.locator("#portable-result").inputValue(), /Proposed agenda/);
    await screenshot("stale-return");
    await page.locator("#portable-older").check(); await page.locator("#portable-submit").click();
    await page.locator("#portable-dialog").waitFor({ state: "hidden" });
    assert.equal(snapshot().state.messages.filter(m => m.proposal).length, 1);
    assert.deepEqual(snapshot().state.workItems, changedWork);
    assert.equal(snapshot().cursor, before.cursor);
    await page.getByText(/Draft · based on revision 0 · older work/).waitFor();

    await open();
    const current = await page.locator("#packet-preview").inputValue();
    await page.locator("#portable-add-result").click();
    const inert = reference(current) + '\n\n<img src="https://example.invalid/private" onerror="window.badReturn=true">\nNo checks performed.';
    await page.locator("#portable-result").fill(inert);
    let attempt = 0;
    await page.route("**/api/rooms/commons/commands", async route => {
      attempt++;
      if (attempt === 1) { await route.fetch(); await route.abort("failed"); }
      else if (attempt === 2) await route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "Try later" } } });
      else await route.continue();
    });
    await page.locator("#portable-submit").click();
    await page.getByText("Save not confirmed. Retry the same draft.", { exact: true }).waitFor();
    assert.equal(snapshot().state.messages.filter(m => m.proposal).length, 2, "server committed the dropped response");
    assert.equal(await page.locator("#portable-result").getAttribute("readonly"), "");
    const firstAttempt = writes.at(-1);
    await page.locator("#portable-close").click(); await open(true);
    assert.equal(await page.locator("#portable-result").inputValue(), inert);
    assert.equal(await page.locator("#portable-result").getAttribute("readonly"), "");
    await page.locator("#portable-submit").click();
    await page.getByText("Save not confirmed. Retry the same draft.", { exact: true }).waitFor();
    assert.equal(await page.locator("#portable-result").getAttribute("readonly"), "", "pre-ledger rate limiting cannot unlock a prior unknown commit");
    assert.deepEqual(writes.at(-1), firstAttempt);
    await page.locator("#portable-close").click(); await open(true);
    await page.locator("#portable-submit").click();
    await page.locator("#portable-dialog").waitFor({ state: "hidden" });
    assert.deepEqual(writes.at(-1), firstAttempt, "retry preserves the original command bytes and ID");
    assert.equal(snapshot().state.messages.filter(m => m.proposal).length, 2);
    assert.equal(await page.evaluate(() => window.badReturn), undefined);
    assert.equal(await page.locator('#message-list img[src*="example.invalid"]').count(), 0);
    assert.deepEqual(snapshot().state.workItems, changedWork);

    await open(true);
    const fontBefore = await page.locator("#portable-result").evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    for (const selector of ["#portable-result", "#packet-preview"]) {
      assert.equal(await page.locator(selector).evaluate(node => parseFloat(getComputedStyle(node).fontSize)), fontBefore * 2, "both editors actually enlarge");
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    await page.locator("#portable-submit").scrollIntoViewIfNeeded();
    const submitBox = await page.locator("#portable-submit").boundingBox();
    assert.ok(submitBox.y >= 0 && submitBox.y + submitBox.height <= page.viewportSize().height, "200% text still allows reaching the submit control");
    await screenshot("large-text");
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.locator("#portable-result").press("Escape");
    assert.equal(await card.locator('[data-portable-mode="result"]').evaluate(node => node === document.activeElement), true);

    // A late clipboard resolution cannot repopulate a logged-out view.
    // Only a portable draft remains, so the composer cannot mask its leave guard.
    await page.locator("#message-input").fill("");
    await open(true); await page.locator("#portable-result").fill(inert); await page.locator("#portable-close").click();
    await open();
    await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise(resolve => { window.finishCopy = resolve; }); });
    await page.locator("#packet-copy").click(); await page.locator("#portable-close").click();
    let confirmations = 0;
    page.on("dialog", dialog => { confirmations++; assert.match(dialog.message(), /clear unsent drafts/); return dialog.accept(); });
    await page.locator("#signout-button").click(); await page.locator("#auth-panel").waitFor({ state: "visible" });
    assert.equal(confirmations, 1, "a closed portable draft alone warns before sign-out");
    assert.equal(await page.locator("#packet-preview").inputValue(), "");
    assert.equal(await page.locator("#portable-status").textContent(), "");
    await page.locator("#access-key").fill(f.keys.owner); await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" }); await open(true);
    assert.equal(await page.locator("#portable-result").inputValue(), "", "sign-out cleared the private draft and retry map");
    await page.locator("#portable-close").click(); await open();
    assert.equal(await page.locator("#packet-copy").isDisabled(), true, "sign-out cannot cancel an already issued system write");
    await page.evaluate(() => window.finishCopy());
    await page.waitForFunction(() => !document.getElementById("packet-copy").disabled);
    assert.equal(await page.locator("#portable-status").textContent(), "", "previous session's copy has no status authority");
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
  });
}
