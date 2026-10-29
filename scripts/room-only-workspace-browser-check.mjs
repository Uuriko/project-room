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

test("account-home session replacement clears old rooms and refresh restores the current account", { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const key = f.store.issueAccountAccessKey(f.store.accountForMember("commons", "owner").id);
  await page.goto(origin + "/?account=1"); await signInFixture(page, key);
  await page.locator('[data-account-room="commons"]').waitFor();
  // A completed sign-in in another tab replaces the browser slot while this
  // tab still holds its previous binding. Use the real account HTTP contract.
  const slot = await (await page.context().request.get(origin + "/api/account-session")).json();
  const replaced = await page.context().request.post(origin + "/api/account-session", {
    headers: { Origin: origin, "X-CSRF-Token": slot.csrf, "X-Session-Binding": slot.sessionBinding },
    data: { accountAccessKey: key, expectedSessionRevision: slot.sessionRevision }
  });
  assert.equal(replaced.status(), 201);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.locator("#auth-error").filter({ hasText: /(?:session|browser account) changed/i }).waitFor();
  assert.equal(await page.locator("#account-rooms-panel").isVisible(), false);
  assert.equal(await page.locator('[data-account-room]').count(), 0);
  await page.locator("#refresh-button").click();
  await page.locator('[data-account-room="commons"]').waitFor();
  assert.equal(await page.locator("#auth-panel").isVisible(), false);
  assert.equal(await page.locator("#auth-error").textContent(), "");
});

for (const target of ["commons", "unavailable-room"]) test(`Google return restores ${target} without probing revoked room cookies`, { timeout: 30000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const account = f.store.accountForMember("commons", "owner");
  const slot = f.store.createAccountSessionSlot();
  f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), slot.session.sessionRevision);
  await page.context().addCookies([{ name: "account_session", value: slot.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await page.goto(origin + "/?account=1");
  await page.locator('[data-account-room="commons"]').waitFor();
  await page.evaluate(async room => { const { stashGoogleRoom } = await import("/src/google-room-return.js"); stashGoogleRoom(room); }, target);
  const reads = [];
  page.on("request", r => { const u = new URL(r.url()); if (u.pathname === "/api/session") reads.push(u.search); });
  await page.goto(origin + "/?room=wrong-fallback&google=signed-in");
  if (target === "commons") await page.locator("#main").waitFor({ state: "visible" });
  else await page.locator('[data-account-room="commons"]').waitFor();
  assert.deepEqual(reads, [`?room=${target}`], "exactly one authorized room restore, no old-cookie probe or fallback-room read");
  assert.equal(new URL(page.url()).searchParams.has("google"), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("project-room:google-room-return:v1")), null);
  assert.equal(await page.locator("#auth-panel").isVisible(), false);
});
