// Room Trust header toggle: owner of a cross-owner room flips the kill-switch.
// Synthetic fixture only. Trust starts on; one click turns it off; another turns it on.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { fillAccessKey } from "./auth-signin.mjs";
import { roomTrust } from "../src/events.js";

async function setup(t, viewport) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const errors = [];
  t.after(async () => {
    await browser.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const open = async key => {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await fillAccessKey(page, key);
    await page.getByRole("button", { name: "Enter room", exact: true }).click();
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  return { ...f, open, trust: () => roomTrust(f.store.room("commons").state) };
}

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`room trust header ${label}: owner flips the kill-switch; a member does not see it`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport);
    const page = await f.open(f.keys.owner);
    const toggle = page.locator("#room-trust-toggle");
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await toggle.textContent(), "Trust");
    assert.match(await toggle.getAttribute("title"), /Turn off to block/);
    const title = await page.locator("#conversation-title").boundingBox();
    const box = await toggle.boundingBox();
    assert.ok(title && box && box.width > 20 && box.height > 20);
    assert.ok(box.x >= title.x, "the toggle sits with the room title");
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("#room-trust-toggle").getAttribute("aria-pressed") === "false");
    assert.equal(await toggle.textContent(), "Trust off");
    assert.equal(f.trust().enabled, false);
    assert.match(await toggle.getAttribute("title"), /Cross-owner assign and wake are blocked/);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("#room-trust-toggle").getAttribute("aria-pressed") === "true");
    assert.equal(await toggle.textContent(), "Trust");
    assert.equal(f.trust().enabled, true);
    const guest = await f.open(f.keys.guest);
    assert.equal(await guest.locator("#room-trust-toggle").isHidden(), true);
  });
}
