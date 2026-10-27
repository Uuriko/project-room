import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { returnToRoom } from "./room-chrome.mjs";

for (const width of [390, 1280]) test(`room-only workspace ${width}: no email surface, safe room return and old-link recovery`, { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [], emailRequests = [], dialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/api\/(inbox|auth\/gmail)(\/|$)/.test(new URL(request.url()).pathname)) emailRequests.push(request.url()); });
  page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const account = f.store.accountForMember("commons", "owner");
  const accountKey = f.store.issueAccountAccessKey(account.id);
  await page.goto(origin + "/?room=commons"); await signInFixture(page, accountKey);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#nav-inbox, #inbox-panel, #inbox-share-dialog, #inbox-send-dialog, #account-setup-dialog").count(), 0);
  await page.locator("#message-input").fill("Keep my unsent room draft");
  await returnToRoom(page);
  assert.equal(await page.locator("#message-input").inputValue(), "Keep my unsent room draft");
  assert.deepEqual(dialogs, [], "returning to the active room never asks to discard drafts");
  await page.evaluate(() => { location.hash = "#pr-view/inbox"; });
  await page.locator("#account-rooms-panel").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "#pr-view/room-list");
  await page.locator('[data-account-room="commons"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.equal(await page.locator("#message-input").inputValue(), "Keep my unsent room draft");
  assert.deepEqual(errors, []); assert.deepEqual(emailRequests, []);
  mkdirSync("test-results/room-only", { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `test-results/room-only/${width}-${theme}.png` });
  }
  for (const path of ["/api/inbox", "/api/inbox/connections", "/api/inbox/channel-sends", "/api/auth/gmail/callback", "/src/inbox-ui.js", "/src/gmail-ui.js"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404, path);
  }
});
