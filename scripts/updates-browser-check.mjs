// Updates destination: actionable badge, palette filters, Open/Done, 390px.
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

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("Updates counts only actionable items and the palette filters work at 390px", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-updates-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "agent", displayName: "Reply Agent", kind: "agent", permissions: ["accept_work"]
  }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const badge = document.querySelector("#updates-count");
    return badge && (badge.hidden || badge.textContent === "");
  });
  assert.equal(await page.locator("#updates-count").textContent(), "");

  const agent = store.issueAccessKey("commons", "agent");
  store.command(agent, "commons", command(T.MESSAGE_POSTED, {
    messageId: crypto.randomUUID(), body: "please confirm the empty-room plan", toMemberId: "owner", requestKind: "reply"
  }));
  await page.locator("#topbar-updates").click();
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Needs me" }).click();
  await page.locator(".updates-row").waitFor();
  assert.match(await page.locator(".updates-row").innerText(), /please confirm the empty-room plan/);
  assert.match(await page.locator("#updates-count").textContent(), /^1$/);

  await page.getByRole("tab", { name: "Needs me" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("[data-update-filter=mentions]")?.getAttribute("aria-selected") === "true");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector("[data-update-filter=needs]")?.getAttribute("aria-selected") === "true");

  await page.getByRole("button", { name: /Open please confirm/ }).click();
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  await page.locator("#room-actions-open").click();
  await page.locator("#room-actions-query").fill("Catch up");
  await page.locator("[data-room-action=catch-up]").click();
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "Saved" }).click();
  await page.locator(".updates-row").waitFor();
  assert.match(await page.locator(".updates-row").innerText(), /read/);
  await page.getByRole("button", { name: /Done please confirm/ }).click();
  await page.getByRole("tab", { name: "Needs me" }).click();
  await page.getByText("Nothing needs you.").waitFor();
  assert.equal(await page.locator("#updates-count").textContent(), "");

  await page.setViewportSize({ width: 390, height: 844 });
  const box = await page.locator("#updates-dialog").boundingBox();
  assert.ok(box.width <= 390);
  const overflow = await page.locator("#updates-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1);
  assert.equal(overflow, true);
  assert.deepEqual(errors, []);
});
