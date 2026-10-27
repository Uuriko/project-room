import { ensurePeopleOpen, openMemberProfile } from "./room-chrome.mjs";
// R9-1: the owner can remove a PERSON (member or guest) from People on a phone,
// with the same two-click confirm agents get. Pause stays agent-only, and the
// owner's own row never offers Remove. Real browser + local HTTP service;
// identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

for (const theme of ["dark", "light"]) test(`People at 390 (${theme}): owner removes a guest with a two-click confirm; no Pause for people`, { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-person-remove-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "riley", displayName: "Riley", kind: "human", permissions: [] }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })).newPage();
  await page.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
  const errors = [], dialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { dialogs.push(dialog.type()); dialog.dismiss(); });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await ensurePeopleOpen(page);
  const row = page.locator('#presence-list .presence-member[data-member-record-id="riley"]');
  const ownerRow = page.locator('#presence-list .presence-member[data-member-record-id="owner"]');
  await openMemberProfile(page, "riley");
  const remove = row.locator("[data-member-remove]");
  assert.equal(await remove.count(), 1, "the owner sees Remove on a person's row");
  assert.equal(await row.locator("[data-member-pause]").count(), 0, "Pause is agent-only");
  assert.equal(await ownerRow.locator("[data-member-remove]").count(), 0, "the owner can't remove themselves");
  assert.ok((await remove.boundingBox()).height >= 24);
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme === "light" ? "light" : null);
  await remove.press("Enter");
  assert.equal(await remove.textContent(), "Confirm remove");
  assert.equal(await page.locator("#main").evaluate(node => node.classList.contains("sidebar-open")), true, "arming Remove keeps the phone drawer open (R327-n1)");
  assert.equal(await row.locator("[data-member-remove-cancel]").isVisible(), true, "Keep is on screen");
  assert.equal(store.room("commons").state.members.riley.active, true, "one tap never removes");
  await row.locator("[data-member-remove-cancel]").press("Enter");
  assert.equal(await remove.textContent(), "Remove");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "phone viewport has no horizontal overflow");
  if (process.env.ROOM_TEST_SCREENSHOT_DIR) {
    mkdirSync(process.env.ROOM_TEST_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.ROOM_TEST_SCREENSHOT_DIR, `person-remove-${theme}.png`) });
  }
  await remove.tap();
  await remove.tap();
  await row.locator(".member-actions").waitFor({ state: "detached" });
  assert.equal(store.room("commons").state.members.riley.active, false, "the confirming tap ended access");
  assert.match(await page.locator("#status").textContent(), /Riley removed\. They can no longer read or post in this room/);
  assert.equal(await row.count(), 1, "the removed person stays in history, without controls");
  assert.deepEqual(dialogs, [], "no native confirm dialog");
  assert.equal(errors.join("\n"), "");
});
