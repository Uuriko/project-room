import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { SyntheticInboxTransport } from "../server/inbox-transport.mjs";
import { SyntheticMailFixture } from "./synthetic-mail-fixture.mjs";
import { randomBytes } from "node:crypto";

async function setup(t, { mobile = false, member = false } = {}) {
  const f = createAcceptanceFixture();
  const accountId = member ? f.store.accountForMember("commons", "guest").id : "inbox-only";
  if (!member) f.store.createAccount(accountId);
  const key = f.store.issueAccountAccessKey(accountId), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  f.store.inbox.apply(slot.token, { action: "source.save", requestId: "sample", sourceId: "private", expectedRevision: 0,
    data: { adapter: "synthetic", sender: "friend@example.test", recipient: "me@example.test", subject: "A small hello", paragraphs: ["What shall we make together?"] } }, session.sessionBinding);
  const provider = new SyntheticMailFixture(join(f.directory, "mail.sqlite"));
  const server = createRoomServer({ store: f.store, streamInterval: 50, syntheticInboxTransport: new SyntheticInboxTransport(f.store.inbox, provider) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    provider.close(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const errors = [], outside = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  const login = async (p = page, accessKey = key) => {
    await p.goto(origin + "/?account=1"); await p.locator("#access-key").fill(accessKey);
    await p.locator("#auth-form button").click(); await p.locator("#inbox-panel").waitFor();
  };
  const capture = async name => { mkdirSync("test-results/account-workspace", { recursive: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "test-results/account-workspace/" + name + ".png" }); };
  return { ...f, page, context, login, capture, accountId, key, slot, session, origin, provider };
}

for (const mobile of [false, true]) test(`account Inbox ${mobile ? "mobile" : "desktop"}: no membership, direct reply, Rooms, reload and sign-out`, { timeout: 35000 }, async t => {
  const f = await setup(t, { mobile }), p = f.page, before = f.store.room("commons");
  await f.login(); await p.locator("#inbox-reader").waitFor(); await f.capture(mobile ? "arrival-mobile" : "arrival-desktop");
  await p.locator("#inbox-draft").fill("Let’s start with one small idea.");
  await p.locator("#inbox-save").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.locator("#inbox-send-preview").click(); await p.locator("#inbox-send-confirm").click();
  await p.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  assert.equal(f.provider.submits, 1); assert.deepEqual(f.store.room("commons"), before);
  await p.locator("#inbox-ask").click(); await p.getByText("No rooms yet.", { exact: true }).waitFor();
  assert.equal(await p.locator("#account-rooms-list button").count(), 0); await f.capture(mobile ? "empty-rooms-mobile" : "empty-rooms-desktop");
  await p.locator("#nav-inbox").click(); await p.reload(); await p.locator("#inbox-reader").waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), "Let’s start with one small idea.");
  await p.locator("#signout-button").click(); await p.locator("#auth-panel").waitFor();
  assert.equal(await p.locator("#inbox-source-body").textContent(), "");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:inbox-position:v1")), null);
});

test("account room discovery and room revocation preserve a private draft, account revocation clears it", { timeout: 35000 }, async t => {
  const f = await setup(t, { member: true }), p = f.page;
  await f.login(); await p.locator("#inbox-reader").waitFor(); await p.locator("#inbox-draft").fill("Unsent private thought");
  await p.locator("#nav-rooms").click(); await p.locator('[data-account-room="commons"]').click(); await p.locator("#main").waitFor();
  await p.locator("#nav-inbox").click(); assert.equal(await p.locator("#inbox-draft").inputValue(), "Unsent private thought");
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.access_changed",
    data: { memberId: "guest", expectedMemberRevision: 0, permissions: [], active: false } });
  await p.waitForFunction(() => document.getElementById("choose-room").hidden);
  await p.locator("#inbox-reader").waitFor(); assert.equal(await p.locator("#inbox-draft").inputValue(), "Unsent private thought");
  await p.locator("#inbox-save").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.locator("#nav-rooms").click(); await p.getByText("No rooms yet.", { exact: true }).waitFor();
  await p.locator("#nav-inbox").click(); await f.capture("room-revoked");
  f.store.changeAccountAccess(f.accountId, { expectedRevision: 0, active: false, reason: "Synthetic end" });
  await p.locator("#inbox-refresh").click(); await p.locator("#auth-panel").waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), "");
  assert.equal(await p.locator("#inbox-source-body").textContent(), "");
});

test("account-only other-tab replacement clears a held private read and navigation metadata", { timeout: 35000 }, async t => {
  const f = await setup(t), p = f.page; await f.login(); await p.locator("#inbox-reader").waitFor();
  let release, started; const held = new Promise(r => { release = r; }), reached = new Promise(r => { started = r; });
  await p.route("**/api/inbox/sources/private", async route => { const response = await route.fetch(); started(); await held; await route.fulfill({ response }); });
  await p.locator("#inbox-refresh").click(); await reached;
  const other = await f.context.newPage(); const account = f.store.accountForMember("commons", "owner");
  await other.goto(f.origin + "/?account=1"); await other.locator("#inbox-panel").waitFor();
  await other.locator("#signout-button").click(); await other.locator("#auth-panel").waitFor();
  await other.locator("#access-key").fill(f.store.issueAccountAccessKey(account.id));
  await other.locator("#auth-form button").click(); await other.locator("#inbox-panel").waitFor();
  await p.locator("#auth-panel").waitFor(); release();
  await p.waitForLoadState("networkidle");
  assert.equal(await p.locator("#inbox-source-body").textContent(), "");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:inbox-position:v1")), null);
});

test("legacy member entry does not expose an account Inbox", { timeout: 20000 }, async t => {
  const f = await setup(t), p = f.page;
  await p.goto(f.origin); await p.locator("#access-key").fill(f.keys.guest); await p.locator("#auth-form button").click();
  await p.locator("#main").waitFor(); assert.equal(await p.locator("#workspace-nav").isVisible(), false);
});

test("an account-home invitation joins explicitly and keeps the private draft", { timeout: 25000 }, async t => {
  const f = await setup(t), p = f.page; await f.login(); await p.locator("#inbox-reader").waitFor();
  await p.locator("#inbox-draft").fill("Keep my private draft");
  const token = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(f.keys.owner, "commons", { requestId: "account-home-link", linkToken: token,
    expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0 });
  const before = f.store.room("commons").sequence;
  await p.evaluate(hash => { location.hash = hash; }, "#join/" + token);
  await p.locator("#join-link-form").waitFor(); assert.equal(f.store.room("commons").sequence, before);
  await p.locator("#join-link-name").fill("Synthetic member"); await p.locator("#join-link-submit").click();
  await p.locator("#join-link-dialog").waitFor({ state: "hidden" }); await p.locator("#main").waitFor();
  await p.locator("#nav-inbox").click(); assert.equal(await p.locator("#inbox-draft").inputValue(), "Keep my private draft");
  assert.equal(f.provider.count(), 0);
  assert.equal(JSON.stringify(f.store.room("commons")).includes("Keep my private draft"), false);
});

test("a lost account-only sign-out response clears private text and leaves a usable sign-in", { timeout: 20000 }, async t => {
  const f = await setup(t), p = f.page; await f.login(); await p.locator("#inbox-reader").waitFor();
  await p.route("**/api/account-session", async route => {
    if (route.request().method() === "DELETE") { await route.fetch(); return route.abort(); }
    return route.continue();
  });
  await p.locator("#signout-button").click(); await p.locator("#auth-panel").waitFor();
  await p.getByText("Sign-out unconfirmed. Sign in to check your account.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-source-body").textContent(), "");
  assert.equal(await p.locator("#access-key").isEnabled(), true);
  await p.locator("#access-key").fill(f.key); await p.locator("#auth-form button").click(); await p.locator("#inbox-reader").waitFor();
});

test("account confirmation failure keeps the draft and reports uncertainty without signing out", { timeout: 20000 }, async t => {
  const f = await setup(t), p = f.page; await f.login(); await p.locator("#inbox-reader").waitFor();
  await p.locator("#inbox-draft").fill("Keep this during a connection issue");
  let unavailable = true;
  await p.route("**/api/account-session", route => unavailable && route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Synthetic outage" } } }) : route.continue());
  await p.getByText("Couldn’t confirm account. Refresh to retry.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), "Keep this during a connection issue");
  assert.equal(await p.locator("#auth-panel").isVisible(), false); unavailable = false;
  await p.locator("#account-status").waitFor({ state: "hidden" });
  assert.equal(await p.locator("#inbox-draft").inputValue(), "Keep this during a connection issue");
});
