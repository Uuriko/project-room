import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createResultsFixture } from "./results-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSearch } from "./room-chrome.mjs";

for (const mobile of [false, true]) for (const theme of ["dark", "light"]) {
  test(`human conversation ${mobile ? "phone" : "desktop"} ${theme}: work is contextual and remains reachable`, { timeout: 60000 }, async t => {
    const f = createResultsFixture();
    const server = createRoomServer({ store: f.store, streamInterval: 40 });
    let browser;
    t.after(async () => {
      await browser?.close(); server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      f.store.close(); rmSync(f.directory, { recursive: true, force: true });
    });
    // Unrelated imported work must not become conversation merely because it
    // has no proposal message. These records remain in the authorized state.
    for (let n = 0; n < 25; n++) f.send("owner", "work.proposed", {
      workItemId: `unrelated-${n}`, title: `Unrelated QA ${n}`, definitionOfDone: "Fixture only",
      accountableMemberId: "producer", independentVerificationRequired: false, ownerDecisionRequired: false
    });
    f.send("owner", "work.proposed", { workItemId: "my-assignment", title: "Review tomorrow's plan", definitionOfDone: "A review",
      accountableMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false, mode: "read" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
    await page.goto(origin); await signInFixture(page, f.keys.owner);
    await page.locator("#main").waitFor({ state: "visible" });
    const cards = page.locator("#message-list [data-work-record-id]");
    assert.equal(await cards.count(), 0);
    assert.equal(await page.locator('#message-list [data-open-work="test-handoff"]').count(), 1);
    assert.match(await page.locator("#message-list .conversation-work-summary").textContent(), /Café notes/);
    assert.doesNotMatch(await page.locator("#message-list").textContent(), /Unrelated QA/);
    await page.locator("#topbar-updates").click();
    await page.getByRole("button", { name: "Open Review tomorrow's plan", exact: true }).click();
    await page.locator('#message-list [data-work-record-id="my-assignment"] [data-action="accept"]').waitFor();
    await page.locator("#work-navigation-return").press("Enter");
    await page.locator("#updates-close").click();
    await page.locator("#message-input").fill("Keep my next thought.");
    await page.locator('#message-list [data-open-work="test-handoff"]').press("Enter");
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().getAttribute("data-work-record-id"), "test-handoff");
    await cards.locator('[data-open-message="test-request"]').press("Enter");
    assert.equal(await cards.count(), 0, "opening the source returns to conversation");
    await page.goBack();
    await page.locator('#message-list [data-work-record-id="test-handoff"]').waitFor();
    await page.locator("#work-navigation-return").press("Enter");
    await page.waitForFunction(() => !document.querySelector("#message-list [data-work-record-id]"));
    assert.equal(await page.locator("#message-input").inputValue(), "Keep my next thought.");
    await openSearch(page);
    await page.locator("#message-search").fill("Unrelated QA 12");
    await page.locator('#search-list [data-open-work="unrelated-12"]').press("Enter");
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().getAttribute("data-work-record-id"), "unrelated-12");
    await page.reload();
    await page.locator('#message-list [data-work-record-id="unrelated-12"]').waitFor();
    assert.equal(await cards.count(), 1, "direct reload reveals only the requested work");
    await page.locator("#work-navigation-return").press("Enter");
    await page.waitForFunction(() => !document.querySelector("#message-list [data-work-record-id]"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    mkdirSync("test-results/human-conversation-work", { recursive: true });
    await page.screenshot({ path: `test-results/human-conversation-work/${mobile ? "phone" : "desktop"}-${theme}.png` });
    assert.deepEqual(errors, []);
    assert.equal(Object.keys(f.state().workItems).length, 30, "navigation preserves all work records");
  });
}
