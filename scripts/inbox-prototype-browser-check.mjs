import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createInboxPrototypeServer } from "./inbox-prototype-server.mjs";

for (const layout of ["split", "focus"]) for (const mobile of [false, true]) {
  test("Inbox/Rooms sample journey " + layout + (mobile ? " mobile" : " desktop"), { timeout: 40000 }, async t => {
    const server = createInboxPrototypeServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    const origin = "http://127.0.0.1:" + server.address().port, errors = [], unexpected = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin || route.request().method() !== "GET") {
        unexpected.push(route.request().url()); return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin); await page.locator("#layout").selectOption(layout);
    mkdirSync("test-results", { recursive: true });
    const prefix = "test-results/inbox-" + layout + (mobile ? "-mobile" : "-desktop");
    await page.screenshot({ path: prefix + "-list.png" });
    await page.locator('[data-thread="launch"]').click();
    await page.locator("#compose").fill("My private email draft");
    await page.locator("#compose").press("Enter");
    assert.equal(await page.locator("#compose").inputValue(), "My private email draft\n");
    assert.equal(await page.locator("#compose-status").textContent(), "");
    await page.screenshot({ path: prefix + "-reading.png" });
    const readingPosition = await page.locator(".reader").evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; });
    await page.locator("#nav-rooms").click();
    assert.equal(await page.locator("#compose").inputValue(), "");
    await page.locator("#compose").fill("Hello from the room");
    await page.locator("#compose").press("Enter");
    if (mobile) {
      assert.equal(await page.locator(".room-message").count(), 1);
      await page.locator("#send").click();
    }
    assert.equal(await page.locator(".room-message").count(), 2);
    await page.locator("#compose").fill("Unsent room thought");
    await page.locator("#nav-inbox").click();
    assert.equal(await page.locator("#compose").inputValue(), "My private email draft\n");
    assert.ok(Math.abs(await page.locator(".reader").evaluate(node => node.scrollTop) - readingPosition) <= 1);
    // The two variants retain the same draft while changing geography.
    await page.locator("#layout").selectOption(layout === "split" ? "focus" : "split");
    assert.equal(await page.locator("#compose").inputValue(), "My private email draft\n");
    await page.locator("#layout").selectOption(layout);
    await page.locator("#ask-room").click();
    assert.equal(await page.locator("#share-submit").isDisabled(), true);
    await page.locator('#share-options input[value="0"]').check(); await page.locator('#share-options input[value="1"]').check();
    await page.screenshot({ path: prefix + "-sharing.png" });
    await page.locator("#share-submit").click();
    assert.equal(await page.locator("#compose").inputValue(), "Unsent room thought");
    assert.equal((await page.locator("#workspace").textContent()).includes("4,200"), false);
    assert.equal((await page.locator("#workspace").textContent()).includes("maya@example.test"), false);
    assert.equal(await page.locator(".excerpt").count(), 1);
    await page.screenshot({ path: prefix + "-room.png" });
    await page.locator("[data-source]").click();
    assert.equal(await page.locator("#compose").inputValue(), "My private email draft\n");
    // Source changes invalidate the open share, without replacing the draft.
    await page.locator(".test-controls > summary").click();
    await page.locator("#ask-room").click(); await page.locator('#share-options input[value="0"]').check();
    // Modal dialog makes background controls inert; emulate the incoming fixture update.
    await page.evaluate(() => document.querySelector("#change-source").click());
    await page.locator("#share-submit").click();
    assert.match(await page.locator("#share-status").textContent(), /Source changed/);
    await page.locator("#share-refresh").click();
    assert.equal(await page.locator("#share-options input:checked").count(), 0);
    assert.match(await page.locator("#share-options").textContent(), /Friday also works/);
    await page.locator("#share-close").click();
    await page.locator(".test-controls > summary").click();
    assert.equal(await page.locator("#send").isDisabled(), true);
    await page.locator("#review-source").click();
    assert.equal(await page.locator("#compose").inputValue(), "My private email draft\n");
    // Known refusal keeps editable text; uncertain outcomes pin the attempt.
    await page.locator(".test-controls > summary").click();
    await page.locator("#reply-behavior").selectOption("offline"); await page.locator(".test-controls > summary").click();
    await page.locator("#send").click();
    assert.match(await page.locator("#compose-status").textContent(), /unavailable/);
    assert.equal(await page.locator("#compose").inputValue(), "My private email draft\n");
    await page.locator(".test-controls > summary").click(); await page.locator("#reply-behavior").selectOption("lost");
    await page.locator(".test-controls > summary").click(); await page.locator("#send").click();
    assert.equal(await page.locator("#compose").getAttribute("readonly"), "");
    assert.equal(await page.locator("#send").textContent(), "Check status");
    await page.screenshot({ path: prefix + "-unknown.png" });
    await page.locator("#nav-rooms").click(); assert.equal(await page.locator("#compose").inputValue(), "Unsent room thought");
    await page.locator("#nav-inbox").click(); assert.equal(await page.locator("#send").textContent(), "Check status");
    await page.locator("#send").click(); assert.equal(await page.locator("#compose").inputValue(), "");
    assert.match(await page.locator("#compose-status").textContent(), /Nothing was delivered/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  });
}
