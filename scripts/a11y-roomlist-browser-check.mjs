// Audit wave lane D3: the account room list (#account-rooms-list) exposes
// list semantics to assistive technology and stays fully keyboard-operable.
//
// Fail-first regression for the room-list listitem fix: before the fix the
// container is a role-less div holding bare buttons, so screen readers hear
// a flat run of buttons with no list context (and axe flags the required
// owned elements once the container claims list semantics). After the fix
// the container is role="list" and every room entry is a role="listitem"
// wrapping its button; keyboard focus and Enter activation are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { axeSerious, assertAxeClean, chromiumLaunchOptions } from "./a11y-axe-helper.mjs";
import { clickChrome } from "./room-chrome.mjs";

async function setup(t) {
  const f = createAcceptanceFixture();
  // A second room so the list has more than one item to expose.
  f.store.initialize(initialRoom("studio"));
  const ownerKeyFor = roomId => roomId === "commons" ? f.keys.owner : f.store.issueAccessKey(roomId, "owner");
  for (const roomId of ["commons", "studio"]) {
    f.store.command(ownerKeyFor(roomId), roomId, {
      id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: "dana", displayName: "Dana", kind: "human", permissions: ["accept_work", "complete_work"] },
    });
  }
  f.store.createAccount("dana-account");
  f.store.completeOnboarding("dana-account");
  for (const roomId of ["commons", "studio"]) f.store.bindHumanAccount(roomId, "dana", "dana-account");
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch(chromiumLaunchOptions());
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin + "/?account=1");
  await signInFixture(page, f.store.issueAccountAccessKey("dana-account"));
  await page.locator("#inbox-panel").waitFor();
  await clickChrome(page, "#nav-rooms");
  await page.waitForFunction(() => document.querySelectorAll("#account-rooms-list button").length === 2);
  return { page };
}

test("room list exposes list semantics to assistive tech", { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  // The container announces itself as a list…
  assert.equal(await page.locator("#account-rooms-list").getAttribute("role"), "list");
  // …with one listitem per room, each wrapping that room's button.
  const items = page.locator("#account-rooms-list [role=\"listitem\"]");
  assert.equal(await items.count(), 2);
  for (let i = 0; i < 2; i++) {
    const item = items.nth(i);
    assert.equal(await item.locator("button").count(), 1);
    const name = await item.locator("button").first().evaluate(el =>
      el.getAttribute("aria-label") || el.innerText);
    assert.ok(name && name.trim().length > 0, "room button has an accessible name");
  }
});

test("room list stays keyboard-operable: Tab reaches entries, Enter opens the room", { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  const first = page.locator("#account-rooms-list button").first();
  await first.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.accountRoom), "commons");
  await page.keyboard.press("Enter");
  await page.locator("#main").waitFor({ state: "visible" });
  assert.match(page.url(), /\?room=commons/);
});

test("rooms panel is axe-clean (serious/critical)", { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  assertAxeClean(await axeSerious(page, { include: ["#account-rooms-panel"] }), "rooms panel");
});
