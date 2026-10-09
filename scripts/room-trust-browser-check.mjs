// Room Trust settings toggle: owner of a cross-owner room flips the kill-switch.
// Synthetic fixture only. Trust starts on; one click turns it off; another turns it on.
import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./browser-harness.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSettings } from "./room-chrome.mjs";
import { roomTrust } from "../src/events.js";

async function setup(t, viewport) {
  const f = await boot(t, { makePage: false, streamInterval: 40 }), { browser, errors, origin } = f;
  t.after(() => { assert.deepEqual(errors, []); });
  const open = async key => {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, key);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  return { ...f, open, trust: () => roomTrust(f.store.room("commons").state) };
}

for (const [label, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`room trust settings ${label}: owner flips the kill-switch; a member does not see it`, { timeout: 60000 }, async t => {
    const f = await setup(t, viewport);
    const page = await f.open(f.keys.owner);
    const toggle = page.locator("#room-trust-toggle");
    assert.equal(await toggle.isVisible(), false, "authority controls stay out of ordinary chat");
    await openSettings(page, "room-permissions");
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await toggle.textContent(), "Cross-owner collaboration on");
    assert.match(await toggle.getAttribute("title"), /Turn off to block/);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("#room-trust-toggle").getAttribute("aria-pressed") === "false");
    assert.equal(await toggle.textContent(), "Cross-owner collaboration off");
    assert.equal(f.trust().enabled, false);
    assert.match(await toggle.getAttribute("title"), /Cross-owner assign and wake are blocked/);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("#room-trust-toggle").getAttribute("aria-pressed") === "true");
    assert.equal(await toggle.textContent(), "Cross-owner collaboration on");
    assert.equal(f.trust().enabled, true);
    const guest = await f.open(f.keys.guest);
    await openSettings(guest, "room-permissions");
    assert.equal(await guest.locator("#room-trust-toggle").isHidden(), true);
  });
}
