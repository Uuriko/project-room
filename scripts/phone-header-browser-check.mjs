// Phone room header: one row at 390px with icon Updates and More that keep
// their accessible names; desktop keeps the text labels.
// Real browser + local HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });

test("Phone room header fits one row and keeps Updates and More named", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-phone-header-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, { memberId: "codex", displayName: "Codex", kind: "agent", permissions: ["accept_work", "complete_work"] }));
  store.command(owner, "commons", command(T.WORK_PROPOSED, { workItemId: "w1", title: "Check the header", definitionOfDone: "One row", accountableMemberId: "owner", mode: "read" }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const open = async width => {
    const page = await (await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: "reduce" })).newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await signInFixture(page, owner);
    await page.locator("#main").waitFor({ state: "visible" });
    await page.locator("#topbar-updates").waitFor({ state: "visible" });
    return { page, errors };
  };
  const measure = page => page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    const updates = document.querySelector("#topbar-updates");
    const icon = updates.querySelector(".topbar-icon");
    const label = updates.querySelector(".topbar-label");
    return {
      header: box(".room-topbar"), heading: box(".conversation-heading"), actions: box(".room-topbar .topbar-actions"),
      updates: box("#topbar-updates"), more: box("#room-more > summary"),
      iconShown: getComputedStyle(icon).display !== "none" && icon.getBoundingClientRect().width > 0,
      labelShown: label.getBoundingClientRect().width > 1,
      updatesText: updates.textContent.replace(/\s+/g, " ").trim(),
      scrollWidth: document.documentElement.scrollWidth
    };
  });

  const phone = await open(390);
  const m = await measure(phone.page);
  assert.ok(m.header.height <= 64, `phone header is one row, got ${m.header.height}px`);
  assert.ok(Math.abs((m.heading.top + m.heading.bottom) / 2 - (m.actions.top + m.actions.bottom) / 2) < 8, "title and actions share the row");
  assert.ok(m.updates.width >= 44 && m.updates.height >= 44 && m.more.width >= 44 && m.more.height >= 44, "touch targets stay 44px");
  assert.equal(m.iconShown, true, "Updates shows its icon on phones");
  assert.equal(m.labelShown, false, "Updates label is visually hidden on phones");
  assert.match(m.updatesText, /^Updates/, "Updates keeps its text for assistive tech");
  assert.equal(await phone.page.getByRole("button", { name: /Updates/ }).count(), 1, "Updates keeps its accessible name");
  assert.equal(await phone.page.locator("#room-more > summary").innerText().catch(() => ""), "More", "More keeps its text name");
  assert.ok(m.scrollWidth <= 390, "no horizontal scroll");
  await phone.page.locator("#topbar-updates").click();
  await phone.page.locator("#updates-dialog").waitFor({ state: "visible" });
  assert.deepEqual(phone.errors, []);

  const desk = await open(1280);
  const d = await measure(desk.page);
  assert.equal(d.iconShown, false, "desktop keeps the text button");
  assert.equal(d.labelShown, true, "desktop shows the Updates label");
  assert.deepEqual(desk.errors, []);
});
