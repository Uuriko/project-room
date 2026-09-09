// Simulated-human navigation checks. Disposable data; no outside services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function setup(t, { mobile = false, role = "owner" } = {}) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const page = await context.newPage(), external = [], errors = [], writes = [];
  page.setDefaultTimeout(8000);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin); await page.locator("#access-key").fill(f.keys[role]); await page.locator("#auth-form button").click();
  await page.locator("#main").waitFor({ state: "visible" });
  page.on("request", request => { if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/rooms/")) writes.push(new URL(request.url()).pathname); });
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); });
  const open = async () => { await page.locator("#room-actions-open").click(); await page.locator("#room-actions-query").waitFor(); };
  const action = id => page.locator(`[data-room-action="${id}"]`);
  const capture = async name => {
    mkdirSync("test-results/room-actions-20260908", { recursive: true });
    await page.screenshot({ path: `test-results/room-actions-20260908/${name}.png` });
  };
  return { ...f, page, origin, open, action, capture };
}

for (const mobile of [false, true]) test(`room actions ${mobile ? "mobile" : "desktop"}: quiet entry, draft preservation, no implicit writes`, { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile }), p = f.page, input = p.locator("#message-input");
  await f.capture(mobile ? "mobile-room" : "desktop-room");
  await input.fill("Keep this unfinished thought. 🪷");
  await input.evaluate(node => node.setSelectionRange(5, 9, "backward"));
  if (mobile) await f.open(); else await input.press("Control+k");
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), true);
  assert.equal(await f.action("write").textContent(), "Continue writing");
  assert.equal(await p.locator("#room-actions-query").evaluate(node => node === document.activeElement), true);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "mobile" : "desktop");
  await p.keyboard.press("Escape");
  assert.equal(await input.inputValue(), "Keep this unfinished thought. 🪷");
  if (!mobile) assert.deepEqual(await input.evaluate(node => [node === document.activeElement, node.selectionStart, node.selectionEnd, node.selectionDirection]), [true, 5, 9, "backward"]);
  await f.open(); await f.action("write").click();
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.equal(await input.inputValue(), "Keep this unfinished thought. 🪷");
});

test("room actions filter by intent, support keyboard selection, empty state and focus wrapping", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.open();
  await p.locator("#room-actions-query").fill("find work");
  assert.equal(await p.locator("[data-room-action]").count(), 1);
  await p.locator("#room-actions-query").press("Enter");
  assert.equal(await p.locator("#message-search").evaluate(node => node === document.activeElement), true);
  await f.open(); await p.locator("#room-actions-query").fill("not a real action");
  await p.locator("#room-actions-empty").waitFor(); await p.keyboard.press("Enter");
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), true);
  await f.capture("no-match");
  await p.locator("#room-actions-query").fill(""); await p.keyboard.press("ArrowDown");
  assert.equal(await f.action("write").evaluate(node => node === document.activeElement), true);
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter");
  assert.equal(await p.locator("#message-search").evaluate(node => node === document.activeElement), true);
  await f.open();
  await p.locator("#room-actions-close").focus(); await p.keyboard.press("Shift+Tab");
  assert.equal(await p.locator("[data-room-action]").last().evaluate(node => node === document.activeElement), true);
  await p.keyboard.press("Tab");
  assert.equal(await p.locator("#room-actions-close").evaluate(node => node === document.activeElement), true);
});

test("room actions open existing work and catch-up flows; shortcuts do not interrupt another dialog", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.open(); await f.action("catch-up").click();
  assert.equal(await p.locator("#return-brief-panel").evaluate(node => node.open), true);
  assert.equal(await p.locator("#return-brief-panel > summary").evaluate(node => node === document.activeElement), true);
  await f.open(); await f.action("new-work").click();
  await p.locator("#work-dialog").waitFor(); await p.locator("#work-title-input").fill("An unsaved idea");
  await p.keyboard.press("Control+k");
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
  assert.equal(await p.locator("#work-title-input").inputValue(), "An unsaved idea");
  await p.locator("#cancel-work-button").click();
  await f.open(); await f.action("people").click();
  assert.equal(await p.locator("#people-panel").evaluate(node => node.open), true);
});

test("room actions offer only the current member's available flows", { timeout: 30000 }, async t => {
  const f = await setup(t, { role: "guest" }); await f.open();
  for (const id of ["new-work", "invite", "agent"]) assert.equal(await f.action(id).count(), 0);
  for (const id of ["write", "search", "catch-up", "people", "work"]) assert.equal(await f.action(id).count(), 1);
  await f.capture("guest");
});

test("room actions recheck stale controls and clear the menu when room access ends", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.open();
  // Hold the visible menu while the backing control changes, as during a refresh.
  await p.locator("#new-work-button").evaluate(node => { node.disabled = true; });
  await f.action("new-work").click();
  assert.equal(await p.locator("#work-dialog").isVisible(), false);
  assert.equal(await f.action("new-work").count(), 0);
  // Trigger the actual sign-out path while the dialog is modal.
  await p.locator("#signout-button").evaluate(node => node.click());
  await p.locator("#room-actions-dialog").waitFor({ state: "hidden" });
  assert.equal(await p.locator("#room-actions-list").textContent(), "");
  assert.equal(await p.locator("#room-actions-query").inputValue(), "");
  await p.keyboard.press("Control+k"); assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
});

test("room actions ignore composition and held Enter without changing drafts", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.open();
  await p.locator("#room-actions-query").fill("new work");
  await p.locator("#room-actions-query").dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await p.locator("#room-actions-query").dispatchEvent("keydown", { key: "Enter", repeat: true, bubbles: true });
  assert.equal(await p.locator("#work-dialog").isVisible(), false);
  assert.equal(await p.locator("#room-actions-dialog").isVisible(), true);
  await p.keyboard.press("Control+k"); assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
});

test("room actions reach work, invitation, agent and instructions without creating anything", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page;
  await f.open(); await f.action("work").click();
  assert.equal(await p.locator("#work-view-work").evaluate(node => node === document.activeElement), true);
  for (const [action, dialog, close] of [
    ["invite", "#share-link-dialog", "#share-link-close"],
    ["agent", "#agent-connect-dialog", "#agent-connect-close"],
    ["instructions", "#room-instructions-dialog", "#room-instructions-close"]
  ]) {
    await f.open(); await f.action(action).click(); await p.locator(dialog).waitFor();
    assert.equal(await p.locator("#room-actions-dialog").isVisible(), false);
    await p.locator(close).click();
  }
});

test("room actions fit a small touch viewport and keep the last action reachable", { timeout: 30000 }, async t => {
  const f = await setup(t, { mobile: true }), p = f.page;
  await p.setViewportSize({ width: 320, height: 568 });
  await f.open();
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.action("instructions").scrollIntoViewIfNeeded();
  const box = await f.action("instructions").boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 568 && box.width >= 44 && box.height >= 44);
  await f.capture("small-touch");
  await f.action("instructions").click(); await p.locator("#room-instructions-dialog").waitFor();
});
