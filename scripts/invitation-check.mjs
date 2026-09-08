// Real-browser proof for fragment-secret handling, non-mutating preview, account-bound
// acceptance, stale-tab fencing, exact replay, draft preservation, and mobile access.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const secret = () => randomBytes(32).toString("base64url");
const chromiumOptions = process.env.ROOM_TEST_CHROMIUM_PATH
  ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH }
  : {};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function counts(store, invitationId) {
  return {
    roomSequence: store.room("studio").sequence,
    invitation: { ...store.db.prepare("SELECT revision,status,accepted_at,redemption_id,joined_event_id FROM membership_invitations WHERE id=?").get(invitationId) },
    audits: store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(invitationId).n,
    bindings: store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='studio' AND account_id='account-target'").get().n
  };
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitation-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const lobby = initialRoom("lobby", "lobby-owner");
  lobby[0].data.title = "Lobby";
  lobby[0].data.purpose = "A familiar conversation to preserve while an invitation is reviewed.";
  store.initialize(lobby);
  const lobbyOwner = store.issueAccessKey("lobby", "lobby-owner");
  store.command(lobbyOwner, "lobby", {
    id: "add-target-to-lobby", type: T.MEMBER_ADDED,
    data: { memberId: "target-member", displayName: "Target human", kind: "human", permissions: ["accept_work", "complete_work", "verify"] }
  });
  const targetRoomKey = store.issueAccessKey("lobby", "target-member", 7 * 86400000, "account-target");

  const studio = initialRoom("studio", "studio-owner");
  studio[0].data.title = "Studio";
  studio[0].data.purpose = "A focused Room for making the next version together.";
  store.initialize(studio);
  store.bindHumanAccount("studio", "studio-owner", "account-studio-owner");
  const ownerAccountKey = store.issueAccountAccessKey("account-studio-owner");
  const targetAccountKey = store.issueAccountAccessKey("account-target");
  store.createAccount("account-other");
  const otherAccountKey = store.issueAccountAccessKey("account-other");
  const ownerSlot = store.createAccountSessionSlot();
  const ownerSession = store.loginAccountSession(ownerSlot.token, ownerAccountKey, ownerSlot.session.sessionRevision);
  const invitationToken = secret();
  const issued = store.issueInvitation(ownerSlot.token, "studio", {
    requestId: "browser-invitation",
    token: invitationToken,
    intendedAccountId: "account-target",
    intendedMemberId: "target-member",
    displayName: "Target human",
    role: "member",
    expiresAt: Date.now() + 3600000,
    expectedIssuerMemberRevision: 0,
    expectedSessionBinding: ownerSession.sessionBinding
  });

  const server = createRoomServer({ store, streamInterval: 30 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...chromiumOptions });
  return { browser, store, origin, targetRoomKey, targetAccountKey, otherAccountKey, invitationToken, invitationId: issued.invitation.id,
    revoke: () => store.revokeInvitation(ownerSlot.token, issued.invitation.id, { expectedRevision: 0, reason: "Offer withdrawn", expectedSessionBinding: ownerSession.sessionBinding }) };
}

async function switchAccount(page, key) {
  return page.evaluate(async accountAccessKey => {
    const restored = await fetch("/api/account-session");
    const account = await restored.json();
    const response = await fetch("/api/account-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": account.csrf },
      body: JSON.stringify({ accountAccessKey, expectedSessionRevision: account.sessionRevision })
    });
    return { status: response.status, body: await response.json() };
  }, key);
}

test("targeted invitation preview retries its retained secret without accepting or losing the opener", { timeout: 45000 }, async t => {
  const { browser, store, origin, targetRoomKey, invitationToken, invitationId } = await fixture(t);
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.locator("#access-key").fill(targetRoomKey);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("Preserve this selected draft.");
  await page.locator("#message-input").evaluate(el => { el.focus(); el.setSelectionRange(0, 8); el.dispatchEvent(new Event("select")); });
  const before = counts(store, invitationId), secrets = [];
  await page.route("**/api/invitations/preview", async route => {
    secrets.push(route.request().postDataJSON().invitationToken);
    if (secrets.length === 1) await route.abort("failed");
    else if (secrets.length === 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporary", message: "Try later." } }) });
    else await route.continue();
  });
  await page.evaluate(token => { location.hash = "#invite/" + token; }, invitationToken);
  await page.locator("#invitation-retry").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "");
  assert.doesNotMatch(await page.locator("#invitation-error").textContent(), /invalid|expired|revoked/);
  await page.locator("#invitation-retry").click();
  await page.locator("#invitation-retry").waitFor({ state: "visible" });
  await page.locator("#invitation-retry").click();
  await page.locator("#invitation-details").waitFor({ state: "visible" });
  assert.deepEqual(secrets, [invitationToken, invitationToken, invitationToken]);
  assert.deepEqual(counts(store, invitationId), before, "preview retries do not accept membership");
  assert.equal(await page.locator("#invitation-retry").isVisible(), false);
  await page.waitForFunction(() => document.activeElement.id === "invitation-account-key");
  await page.locator("#invitation-dismiss").click();
  await page.waitForFunction(() => document.activeElement.id === "message-input");
  assert.equal(await page.locator("#message-input").inputValue(), "Preserve this selected draft.");
  assert.deepEqual(await page.locator("#message-input").evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 8]);
});

test("invitation preview and acceptance preserve privacy, drafts, authority, and stale-tab ownership", { timeout: 90000 }, async t => {
  const { browser, store, origin, targetRoomKey, targetAccountKey, otherAccountKey, invitationToken, invitationId } = await fixture(t);
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requestEvidence = [];
  page.on("request", request => requestEvidence.push({ url: request.url(), referer: request.headers().referer ?? "", body: request.postData() ?? "" }));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await page.locator("#access-key").fill(targetRoomKey);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  assert.match(await page.locator("#identity-label").textContent(), /^Target human/);

  const composer = page.locator("#message-input");
  await composer.fill("Keep this private lobby draft");
  await page.locator("#message-to-select").selectOption("lobby-owner");
  await composer.focus();
  await composer.evaluate(element => element.setSelectionRange(12, 12));
  for (let index = 0; index < 7; index++) await page.keyboard.press("Shift+ArrowLeft");
  assert.deepEqual(await composer.evaluate(element => [element === document.activeElement, element.selectionStart, element.selectionEnd, element.selectionDirection]), [true, 5, 12, "backward"]);
  await composer.dispatchEvent("select");
  const beforePreview = counts(store, invitationId);
  await page.evaluate(token => { location.hash = `invite/${token}`; }, invitationToken);
  await page.locator("#invitation-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#invitation-details")?.hidden === false);

  assert.equal(page.url().includes(invitationToken), false, "the fragment is replaced before invitation work continues");
  const browserLeak = await page.evaluate(token => ({
    dom: document.documentElement.outerHTML.includes(token),
    local: Object.values(localStorage).some(value => value.includes(token)),
    session: Object.values(sessionStorage).some(value => value.includes(token)),
    resources: performance.getEntriesByType("resource").some(entry => entry.name.includes(token))
  }), invitationToken);
  assert.deepEqual(browserLeak, { dom: false, local: false, session: false, resources: false });
  assert.equal(requestEvidence.some(item => item.url.includes(invitationToken) || item.referer.includes(invitationToken)), false);
  assert.equal(requestEvidence.filter(item => item.body.includes(invitationToken)).length, 1, "only the preview POST body carries the invitation secret");
  assert.match(await page.locator("#invitation-boundary").textContent(), /haven’t joined.*no notification or read receipt is sent/i);
  assert.match(await page.locator("#invitation-room").textContent(), /Studio/);
  assert.deepEqual(counts(store, invitationId), beforePreview, "preview creates no event, membership, audit, or status write");
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/invitation-desktop.png" });

  await page.locator("#invitation-dismiss").click();
  await page.locator("#invitation-dialog").waitFor({ state: "hidden" });
  assert.equal(await composer.inputValue(), "Keep this private lobby draft");
  assert.equal(await page.locator("#message-to-select").inputValue(), "lobby-owner");
  assert.deepEqual(await composer.evaluate(element => [element === document.activeElement, element.selectionStart, element.selectionEnd, element.selectionDirection]), [true, 5, 12, "backward"]);

  await page.setViewportSize({ width: 390, height: 844 });
  await composer.focus();
  await page.evaluate(token => { location.hash = `invite/${token}`; }, invitationToken);
  await page.locator("#invitation-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#invitation-details")?.hidden === false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: "test-results/invitation-mobile.png" });
  for (const button of await page.locator("#invitation-dialog button:visible").all()) {
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    assert.ok(box.height >= 44, `invitation control height ${box.height} is at least 44px`);
    assert.ok(box.y >= 0 && box.y + box.height <= 844, "each invitation control can be brought fully into the mobile viewport");
  }
  await page.screenshot({ path: "test-results/invitation-mobile-actions.png" });

  await page.locator("#invitation-account-key").fill(targetAccountKey);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  await page.getByRole("button", { name: "Accept and open room", exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "Keep this private lobby draft", "same-account transition retains the current Room draft before acceptance");
  assert.equal(await page.locator("#message-to-select").inputValue(), "lobby-owner");
  const cookiesBeforeAccept = new Map((await context.cookies()).map(cookie => [cookie.name, cookie.value]));
  assert.ok(cookiesBeforeAccept.has("room_session"));
  assert.ok(cookiesBeforeAccept.has("account_session"));

  const committed = deferred(), release = deferred();
  let acceptSetCookie;
  t.after(() => release.resolve());
  await page.route("**/api/invitations/accept", async route => {
    const response = await route.fetch();
    acceptSetCookie = response.headers()["set-cookie"];
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Accept and open room", exact: true }).click();
  await committed.promise;
  const afterCommit = counts(store, invitationId);
  assert.equal(afterCommit.invitation.status, "accepted");
  assert.equal(afterCommit.bindings, 1);
  assert.equal(acceptSetCookie, undefined, "acceptance never rotates either browser cookie");

  const otherTab = await context.newPage();
  await otherTab.goto(origin);
  const switched = await switchAccount(otherTab, otherAccountKey);
  assert.equal(switched.status, 201);
  assert.equal(switched.body.account.id, "account-other");
  release.resolve();
  await page.waitForFunction(() => document.querySelector("#invitation-error")?.textContent.includes("browser account changed"));
  assert.equal(new URL(page.url()).searchParams.get("room"), null, "a held old-account response cannot navigate the replacement account");
  assert.equal(await page.locator("#status").textContent(), "", "a held response cannot announce acceptance into the replacement account UI");
  assert.deepEqual(counts(store, invitationId), afterCommit, "the held response causes no duplicate membership or audit write");

  await page.locator("#invitation-account-key").fill(targetAccountKey);
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  await page.getByRole("button", { name: "Accept and open room", exact: true }).waitFor();
  await page.getByRole("button", { name: "Accept and open room", exact: true }).click();
  await page.waitForURL(`${origin}/?room=studio`);
  await page.locator("#main").waitFor({ state: "visible" });
  assert.match(await page.locator("#identity-label").textContent(), /^Target human/);
  assert.equal(await page.locator("#conversation-title").textContent(), "# studio");
  assert.equal(await composer.inputValue(), "", "private drafts clear only after the confirmed account/Room switch");
  assert.deepEqual(counts(store, invitationId), afterCommit, "the exact lost-response replay is a no-write receipt");
  const cookiesAfterAccept = new Map((await context.cookies()).map(cookie => [cookie.name, cookie.value]));
  assert.equal(cookiesAfterAccept.get("room_session"), cookiesBeforeAccept.get("room_session"));
  assert.equal(cookiesAfterAccept.get("account_session"), cookiesBeforeAccept.get("account_session"));
  assert.deepEqual(errors, []);
});

test("malformed invitation fragments are scrubbed locally and never sent", { timeout: 90000 }, async t => {
  const { browser, origin } = await fixture(t);
  const page = await (await browser.newContext()).newPage();
  const bodies = [];
  page.on("request", request => bodies.push(request.postData() ?? ""));
  const malformed = "not-a-valid-invitation-secret";
  await page.goto(`${origin}/#invite/${malformed}`);
  await page.locator("#invitation-dialog").waitFor({ state: "visible" });
  assert.equal(page.url().includes(malformed), false);
  assert.match(await page.locator("#invitation-error").textContent(), /unavailable/i);
  assert.equal(await page.locator("#invitation-summary").textContent(), "This invitation is unavailable.");
  assert.equal(bodies.some(body => body.includes(malformed)), false);
});

test("account confirmation keeps the modal open and warns before a draft-sensitive sign-in", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(f.origin);
  await page.locator("#access-key").fill(f.targetRoomKey);
  await page.getByRole("button", { name: "Enter room", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#message-input").fill("Retain this draft until I choose to switch");
  await page.evaluate(token => { location.hash = `invite/${token}`; }, f.invitationToken);
  await page.locator("#invitation-account-key").waitFor({ state: "visible" });
  assert.match(await page.locator("#invitation-account-warning").textContent(), /Switching accounts clears.*drafts.*Save a copy first/i);
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector("#invitation-dialog").contains(document.activeElement)), true);
  }
  await page.locator("#invitation-account-key").fill(f.targetAccountKey);
  let confirmations = 0;
  page.once("dialog", async dialog => { confirmations++; assert.match(dialog.message(), /clears.*unsent drafts/i); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  assert.equal(confirmations, 1);
  assert.equal(await page.locator("#message-input").inputValue(), "Retain this draft until I choose to switch");
  const held = deferred(), release = deferred();
  t.after(() => release.resolve());
  await page.route("**/api/account-session", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  await held.promise;
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#invitation-dialog").evaluate(element => element.open), true);
  assert.equal(await page.locator("#invitation-dismiss").isDisabled(), true);
  release.resolve();
  await page.getByRole("button", { name: "Accept and open room", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "invitation-accept");
  assert.equal(await page.locator("#message-input").inputValue(), "Retain this draft until I choose to switch");
});

test("an invalidated offer removes acceptance controls and returns keyboard focus to dismissal", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await page.locator("#invitation-account-key").fill(f.targetAccountKey);
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  await page.getByRole("button", { name: "Accept and open room", exact: true }).waitFor();
  f.revoke();
  await page.locator("#invitation-accept").click();
  await page.waitForFunction(() => document.querySelector("#invitation-error").textContent.includes("revoked"));
  assert.equal(await page.locator("#invitation-accept").isVisible(), false);
  assert.equal(await page.locator("#invitation-account-form").isVisible(), false);
  assert.equal(await page.locator("#invitation-summary").textContent(), "This invitation is unavailable.");
  await page.waitForFunction(() => document.activeElement?.id === "invitation-dismiss");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#invitation-dialog").evaluate(element => element.open), false);
});

test("account mismatch focuses the account field for recovery", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await page.locator("#invitation-account-key").fill(f.otherAccountKey);
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  await page.getByRole("button", { name: "Accept and open room", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === "invitation-account-key" && document.querySelector("#invitation-error").textContent.includes("another account"));
  assert.equal(await page.locator("#invitation-accept").isVisible(), false);
});

test("uncertain acceptance retains its retry on cancelled dismissal and accepted Room-load failure stays neutral", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const page = await (await f.browser.newContext()).newPage();
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await page.locator("#invitation-account-key").fill(f.targetAccountKey);
  await page.getByRole("button", { name: "Sign in to review acceptance", exact: true }).click();
  await page.route("**/api/invitations/accept", route => route.abort());
  await page.getByRole("button", { name: "Accept and open room", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#invitation-error").textContent.includes("could not confirm"));
  await page.waitForFunction(() => document.activeElement?.id === "invitation-accept");
  page.once("dialog", async dialog => { assert.match(dialog.message(), /clears this tab’s retry information/); await dialog.dismiss(); });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#invitation-dialog").evaluate(element => element.open), true);
  await page.unroute("**/api/invitations/accept");
  await page.getByRole("button", { name: "Check acceptance again", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.goto(`${f.origin}/#invite/${f.invitationToken}`);
  await page.getByRole("button", { name: "Open room", exact: true }).waitFor();
  await page.route("**/api/session?room=studio", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporarily_unavailable", message: "Room temporarily unavailable" } }) }));
  await page.getByRole("button", { name: "Open room", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#auth-error").textContent.includes("already accepted, but the Room could not be loaded"));
  assert.equal(await page.locator("#auth-error").textContent().then(text => text.includes("account that accepted")), false);
});
