// A returning member who opens a friend's link and signs in with Google must
// land on that invitation, not in their own first room. The Google callback
// sends anyone who already has a room to /?room=<first room>, and the OAuth
// stash restore used to refuse any ?room= landing, so the friend's link was
// dropped for every returning member. Provider endpoints are synthetic; every
// Room route, cookie and the share link are real.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { googleAuth, sub } from "./helpers/google-oauth-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

for (const kind of ["join", "invite"]) test(`returning Google member keeps a friend's #${kind}/ link through sign-in`, { timeout: 40000 }, async t => {
  const f = createAcceptanceFixture();
  const accountId = `google:${sub}`;
  f.store.createAccount(accountId, "google"); f.store.completeOnboarding(accountId);
  // The member already has a room of their own, so the callback lands on it.
  const home = initialRoom("a-home", "home-owner");
  home[0].data.title = "My own room";
  f.store.initialize(home);
  f.store.bindHumanAccount("a-home", "home-owner", accountId);
  const token = randomBytes(32).toString("base64url");
  let fragment;
  if (kind === "join") {
    f.store.shareLinks.create(f.keys.owner, "commons", { requestId: "friend-link", linkToken: token,
      expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 0 });
    fragment = `#join/${token}`;
  } else {
    const ownerKey = f.store.issueAccountAccessKey(f.store.accountForMember("commons", "owner").id);
    const slot = f.store.createAccountSessionSlot();
    const session = f.store.loginAccountSession(slot.token, ownerKey, slot.session.sessionRevision);
    const members = f.store.snapshot(f.keys.owner, "commons").state.members;
    const issuer = Array.isArray(members) ? members.find(member => member.id === "owner") : members.owner;
    f.store.issueInvitation(slot.token, "commons", { requestId: "friend-invitation", token, intendedAccountId: accountId,
      intendedMemberId: "returning-friend", displayName: "Returning friend", role: "member", expiresAt: Date.now() + 3600000,
      expectedIssuerMemberRevision: issuer?.revision ?? 0, expectedSessionBinding: session.sessionBinding });
    fragment = `#invite/${token}`;
  }
  const server = createRoomServer({ store: f.store, googleAuth: googleAuth() });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = createServer((req, res) => {
    const url = new URL(req.url, "https://accounts.google.com");
    res.writeHead(302, { Location: `${origin}/api/auth/google/callback?state=${url.searchParams.get("state")}&code=synthetic-google-code` }); res.end();
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerOrigin = `http://localhost:${provider.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
  await page.route(`${origin}/api/auth/google/start`, async route => {
    const response = await route.fetch({ maxRedirects: 0 }); assert.equal(response.status(), 302);
    const authorize = new URL(response.headers().location);
    await route.fulfill({ response, headers: { ...response.headers(), location: providerOrigin + authorize.pathname + authorize.search } });
  });
  await page.goto(origin + "/" + fragment);
  const callback = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/google/callback");
  if (kind === "join") {
    await page.locator("#join-link-form").waitFor();
    if (await page.locator("#join-account-signin").isVisible()) await page.locator("#join-account-signin").click();
    await page.locator("#join-account-google").click();
  } else {
    await page.locator("#invitation-dialog").waitFor({ state: "visible" });
    await page.locator("#invitation-google").click();
  }
  assert.equal((await callback).status(), 200);
  await page.waitForURL(url => new URL(url).pathname === "/" && new URL(url).searchParams.get("room") === "a-home");
  const dialog = kind === "join" ? "#join-link-dialog" : "#invitation-dialog";
  try { await page.locator(dialog).waitFor({ state: "visible", timeout: 8000 }); }
  catch (error) {
    error.message += "\nLanding: " + JSON.stringify(await page.evaluate(() => ({ search: location.search, hash: location.hash,
      title: document.querySelector("#room-title")?.textContent || null }))); throw error;
  }
  if (kind === "join") {
    await page.locator("#join-link-submit").filter({ hasText: /^Join room$/ }).waitFor();
    await page.locator("#join-link-name").fill("Returning friend"); await page.locator("#join-link-submit").click();
    await page.locator(dialog).waitFor({ state: "hidden" });
    await page.waitForFunction(() => new URLSearchParams(location.search).get("room") === "commons");
  } else {
    await page.locator("#invitation-accept").waitFor({ state: "visible" });
    await page.locator("#invitation-accept").click();
    await page.locator(dialog).waitFor({ state: "hidden" });
    await page.waitForFunction(() => new URLSearchParams(location.search).get("room") === "commons");
  }
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='commons' AND account_id=?").get(accountId).n, 1,
    "the friend's link joins the returning member to the friend's room");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("pr-pending-join") ?? sessionStorage.getItem("pr-pending-invite")), null, "stash stays one-shot");
  assert.deepEqual(errors, []);
});
