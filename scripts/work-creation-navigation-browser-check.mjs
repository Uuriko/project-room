import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { messageAction, openComposerOptions } from "./room-chrome.mjs";

async function setup(t, mobile = false, thread = false) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, reducedMotion: "reduce", isMobile: mobile, hasTouch: mobile });
  page.setDefaultTimeout(8000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await signInFixture(page, f.keys.owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("Keep my room draft");
  if (thread) {
    await messageAction(page, "test-welcome", "reply");
    await page.locator("#message-input").fill("Keep my thread draft");
    await page.locator("#message-input").evaluate(input => input.setSelectionRange(5, 14));
  }
  const origin = page.url();
  if (thread) await messageAction(page, "test-welcome", "work");
  else { await openComposerOptions(page); await page.locator("#new-work-button").click(); }
  await page.locator("#work-title-input").fill("New navigation task");
  await page.locator("#work-done-input").fill("Open the confirmed task without another search.");
  await page.locator("#work-options > summary").click();
  await page.locator("#assignee-select").selectOption("owner");
  await page.locator("#require-verification").uncheck();
  await page.locator("#require-decision").uncheck();
  const create = () => page.locator("#create-work-button").click();
  const created = () => Object.values(f.store.room("commons").state.workItems).filter(item => item.title === "New navigation task");
  return { ...f, page, origin, create, created };
}

for (const mobile of [false, true]) test(`confirmed creation opens exact work and Back preserves draft (${mobile ? "touch" : "desktop"})`, async t => {
  const f = await setup(t, mobile); await f.create();
  await f.page.locator("#new-work-form").waitFor({ state: "hidden" });
  const items = f.created(); assert.equal(items.length, 1);
  const card = f.page.locator(`[data-work-record-id="${items[0].id}"]`);
  await card.waitFor({ state: "visible" });
  await f.page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, items[0].id);
  assert.equal(items[0].state, "proposed", "navigation never accepts or starts work");
  assert.notEqual(f.page.url(), f.origin);
  mkdirSync("test-results", { recursive: true });
  await f.page.screenshot({ path: `test-results/work-created-${mobile ? "touch" : "desktop"}.png` });
  await f.page.goBack(); await card.waitFor({ state: "hidden" });
  assert.equal(f.page.url(), f.origin);
  assert.equal(await f.page.locator("#message-input").inputValue(), "Keep my room draft");
});

for (const outcome of ["committed-lost", "uncommitted-lost", "wrong-receipt"]) test(`creation ${outcome} navigates only after exact retry confirmation`, async t => {
  const f = await setup(t), attempts = [];
  await f.page.route("**/commands", async route => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length > 1) return route.continue();
    if (outcome === "uncommitted-lost") return route.abort("failed");
    const response = await route.fetch();
    if (outcome === "committed-lost") return route.abort("failed");
    const receipt = await response.json(); receipt.event.actorId = "guest";
    return route.fulfill({ response, json: receipt });
  });
  await f.create(); await f.page.locator("#retry-work-button").waitFor({ state: "visible" });
  assert.equal(f.page.url(), f.origin);
  assert.equal(await f.page.locator("[data-work-record-id]").count(), 0);
  await f.page.locator("#retry-work-button").click();
  await f.page.locator(`[data-work-record-id="${attempts[0].data.workItemId}"]`).waitFor({ state: "visible" });
  assert.deepEqual(attempts[1], attempts[0]); assert.equal(f.created().length, 1);
});

for (const replacement of ["destination", "session"]) test(`held creation cannot navigate a replacement ${replacement}`, async t => {
  const f = await setup(t); let release, arrived;
  const held = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await f.page.route("**/commands", async route => {
    const response = await route.fetch(); arrived(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await f.create(); await held;
  if (replacement === "destination") await f.page.evaluate(() => history.pushState({}, "", "#another-destination"));
  else {
    f.store.issueAccessKey("commons", "owner");
    await f.page.locator("#auth-panel").waitFor({ state: "visible" });
  }
  const destination = f.page.url(); release();
  await f.page.unroute("**/commands", { behavior: "wait" });
  if (replacement === "destination") await f.page.locator("#new-work-form").waitFor({ state: "hidden" });
  assert.equal(f.page.url(), destination);
  assert.equal(await f.page.locator("[data-work-record-id]").count(), 0);
  assert.equal(f.created().length, 1, "a committed task survives even when navigation is discarded");
});

for (const mobile of [false, true]) test(`source thread creation restores its draft and selection on Back (${mobile ? "touch" : "desktop"})`, async t => {
  const f = await setup(t, mobile, true); await f.create();
  const card = f.page.locator(`[data-work-record-id="${f.created()[0].id}"]`);
  await card.waitFor({ state: "visible" });
  assert.equal(f.created()[0].sourceMessageId, "test-welcome");
  await f.page.goBack(); await card.waitFor({ state: "hidden" });
  assert.equal(f.page.url(), f.origin);
  const input = f.page.locator("#message-input");
  assert.equal(await input.inputValue(), "Keep my thread draft");
  assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [5, 14]);
});

for (const moveAway of [false, true, "thread-roundtrip"]) test(`confirmed creation survives failed refresh (${moveAway || "recover"})`, async t => {
  const f = await setup(t); let committed = false, blockedReads = 0, recovering = false;
  await f.page.route("**/api/rooms/commons**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/commands") && request.method() === "POST") {
      const response = await route.fetch(); committed = true;
      return route.fulfill({ response });
    }
    if (committed && !recovering && request.method() === "GET" && url.pathname === "/api/rooms/commons") {
      blockedReads++; return route.abort("failed");
    }
    return route.continue();
  });
  await f.create(); await f.page.locator("#new-work-form").waitFor({ state: "hidden" });
  assert.ok(blockedReads > 0, "the confirmed write must survive an actual refresh failure");
  assert.equal(f.created().length, 1);
  if (moveAway === "thread-roundtrip") {
    await messageAction(f.page, "test-welcome", "reply");
    await f.page.locator("#thread-back").click();
  } else if (moveAway) await f.page.evaluate(() => history.pushState({}, "", "#another-destination"));
  const destination = f.page.url();
  recovering = true;
  const id = f.created()[0].id;
  if (!moveAway) await f.page.locator(`[data-work-record-id="${id}"]`).waitFor({ state: "visible" });
  else {
    await f.page.waitForResponse(response => new URL(response.url()).pathname === "/api/rooms/commons" && response.ok());
    assert.equal(f.page.url(), destination);
    assert.equal(await f.page.locator(`[data-work-record-id="${id}"]`).count(), 0);
  }
  assert.equal(f.created().length, 1, "read recovery must never submit another task");
});
