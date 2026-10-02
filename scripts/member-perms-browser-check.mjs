// MEMBER-PERMS PR2: simulated browser journeys against a disposable real server.
// Authoring gate: these own UI wiring, selection, retry and session lifecycle.
// Credible regressions are posting admission instead of an authenticated upgrade,
// sending unselected grants, duplicating a committed request after response loss,
// or painting the previous member's callback into a new session. HTTP tests do
// not mount the UI; these use no production test seams or fabricated API replies.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AccessRequests } from "../server/access-requests.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { signInFixtureInPlace } from "./in-place-fixture-signin.mjs";
import { clickChrome, openMemberProfile } from "./room-chrome.mjs";

const requestPath = "/api/rooms/commons/members/me/permission-requests";
const isPermissionRequest = request => request.method() === "POST" && new URL(request.url()).pathname === requestPath;
const ownRow = (page, memberId = "requester") => page.locator(`#presence-list [data-member-record-id="${memberId}"]`);
const attentionRow = (page, name = "Permission Requester") => page.locator("#attention-list > li").filter({ hasText: name });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  for (const [id, displayName, permissions] of [
    ["requester", "Permission Requester", []],
    ["other", "Other Member", []],
    ["admin", "Permission Admin", ["manage_members", "accept_work"]],
  ]) {
    store.command(keys.owner, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: id, displayName, kind: "human", permissions } });
    keys[id] = store.issueAccessKey("commons", id);
  }
  const server = createRoomServer({ store, streamInterval: 40 });
  let browser;
  const errors = [], releases = [];
  t.after(async () => {
    releases.forEach(release => release());
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    assert.deepEqual(errors, [], "browser runtime has no uncaught errors");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const login = async memberId => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await signInFixture(page, keys[memberId]);
    await page.locator("#main").waitFor({ state: "visible" });
    return page;
  };
  const api = async (path, memberId = "owner", data) => {
    const response = await fetch(`${origin}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${keys[memberId]}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const access = new AccessRequests(store);
  return { store, keys, login, api, access,
    pending: () => access.list(keys.owner, "commons"),
    permissions: memberId => store.roomAuthority("commons").members[memberId].permissions,
    hold: () => { const gate = deferred(); releases.push(gate.resolve); return gate; },
  };
}

async function ask(page, memberId = "requester") {
  await openMemberProfile(page, memberId);
  const reply = page.waitForResponse(response => isPermissionRequest(response.request()));
  await ownRow(page, memberId).getByRole("button", { name: "Ask to take work", exact: true }).click();
  const response = await reply;
  assert.equal(response.status(), 201, await response.text());
  return response.json();
}

async function decide(page, label, expectedStatus = 200) {
  const reply = page.waitForResponse(response => response.request().method() === "POST"
    && /\/access-requests\/[^/]+\/decide$/.test(new URL(response.url()).pathname));
  await attentionRow(page).getByRole("button", { name: label, exact: true }).click();
  const response = await reply;
  assert.equal(response.status(), expectedStatus, await response.text());
  return response.json();
}

test("a basic member requests work permissions, the owner approves, and the member can claim work", { timeout: 60000 }, async t => {
  const f = await setup(t);
  assert.equal((await f.api("/api/rooms/commons/work-claims", "owner", { id: "permission-work", title: "Permission browser work" })).status, 201);
  assert.equal((await f.api("/api/rooms/commons/work-claims/permission-work/claim", "requester", {})).status, 403);
  const page = await f.login("requester");
  await openMemberProfile(page, "requester");
  assert.equal(await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).count(), 1);
  assert.equal(await ownRow(page, "other").getByRole("button", { name: "Ask to take work", exact: true }).count(), 0,
    "a member cannot file a request as somebody else");
  const request = await ask(page);
  assert.equal(request.kind, "permissions");
  assert.equal(request.memberId, "requester");
  assert.deepEqual(request.requestedPermissions, ["accept_work", "complete_work"]);
  await ownRow(page).locator("[data-permission-request-status]").filter({ hasText: "Waiting for review." }).waitFor();
  assert.equal(f.pending().length, 1);
  assert.deepEqual(f.permissions("requester"), [], "asking does not grant authority");
  assert.equal(await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).count(), 0);

  const joiner = f.store.identities.create("Ordinary Joiner");
  f.access.request("commons", { identityId: joiner.identityId, displayName: "Ordinary Joiner",
    requestedPermissions: [], requestId: "browser_join_request" });
  const owner = await f.login("owner"), row = attentionRow(owner);
  await row.waitFor();
  assert.equal(await row.locator(".attention-kind").textContent(), "Permission request");
  assert.match(await row.locator(".attention-detail").textContent(), /accept_work/);
  assert.match(await row.locator(".attention-detail").textContent(), /complete_work/);
  assert.equal(await attentionRow(owner, "Ordinary Joiner").locator(".attention-kind").textContent(), "Join request");
  await decide(owner, "Approve");
  await row.waitFor({ state: "detached" });
  await page.locator("#message-list").getByText(new RegExp(`Approved permission request ${request.requestId}`)).waitFor();
  assert.deepEqual(f.permissions("requester"), ["accept_work", "complete_work"]);
  await ownRow(page).locator("[data-permission-request-status]").filter({ hasText: "You can take work now." }).waitFor();
  await page.locator("#tasks-board-open").click();
  const card = page.locator('article[data-claim-id="permission-work"]');
  await card.getByRole("button", { name: "Claim", exact: true }).click();
  await page.locator('[aria-labelledby="board-col-claimed"] article[data-claim-id="permission-work"]').waitFor();
  assert.equal(await page.locator("#board-status").textContent(), "Claimed 'Permission browser work'");
  assert.equal(f.store.workClaims.get("commons", "permission-work").owner, "requester");
});

test("an admin can cancel partial review, approve only selected permissions, and decline the remainder", { timeout: 60000 }, async t => {
  const f = await setup(t), member = await f.login("requester");
  await ask(member);
  const admin = await f.login("admin"), row = attentionRow(admin);
  await row.waitFor();
  assert.equal(await row.locator(".attention-kind").textContent(), "Permission request");
  assert.equal(await row.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true,
    "an admin is not offered a grant it does not hold");
  assert.match(await row.textContent(), /You cannot grant: complete_work/);
  assert.deepEqual(f.permissions("requester"), []);
  let writes = 0;
  admin.on("request", request => { if (request.method() === "POST" && /\/decide$/.test(new URL(request.url()).pathname)) writes++; });
  const sequence = f.store.room("commons").sequence;
  await row.getByRole("button", { name: "Approve partial", exact: true }).click();
  const selection = row.locator("fieldset");
  await selection.waitFor();
  assert.equal(await selection.getByRole("checkbox").count(), 2);
  assert.equal(await selection.getByRole("checkbox", { name: "complete_work", exact: true }).isDisabled(), true);
  assert.equal(await selection.getByRole("checkbox", { name: "complete_work", exact: true }).isChecked(), false);
  await selection.getByRole("checkbox", { name: "accept_work", exact: true }).uncheck();
  assert.equal(await row.getByRole("button", { name: "Approve selected", exact: true }).isDisabled(), true);
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await selection.waitFor({ state: "detached" });
  assert.equal(writes, 0, "opening, selecting and cancelling sends no decision");
  assert.equal(f.store.room("commons").sequence, sequence, "cancel appends no room event");
  assert.equal(f.pending().length, 1);

  await row.getByRole("button", { name: "Approve partial", exact: true }).click();
  await selection.getByRole("checkbox", { name: "accept_work", exact: true }).check();
  assert.equal(await selection.getByRole("checkbox", { name: "complete_work", exact: true }).isChecked(), false);
  const approved = await decide(admin, "Approve selected");
  await row.waitFor({ state: "detached" });
  assert.deepEqual(approved.grantedPermissions, ["accept_work"]);
  assert.deepEqual(f.permissions("requester"), ["accept_work"]);
  await member.locator("#message-list").getByText(new RegExp(`Approved permission request ${approved.requestId}`)).waitFor();
  const checked = member.waitForResponse(response => isPermissionRequest(response.request()));
  await ownRow(member).getByRole("button", { name: "Check request", exact: true }).click();
  assert.equal((await (await checked).json()).status, "approved");
  const remainder = await ask(member);
  assert.deepEqual(remainder.requestedPermissions, ["complete_work"], "the next request asks only for missing permissions");
  await row.waitFor();
  assert.match(await row.locator(".attention-detail").textContent(), /complete_work/);
  assert.doesNotMatch(await row.locator(".attention-detail").textContent(), /accept_work/);
  await decide(admin, "Decline");
  await row.waitFor({ state: "detached" });
  await member.locator("#message-list").getByText(new RegExp(`Declined permission request ${remainder.requestId}`)).waitFor();
  const declineChecked = member.waitForResponse(response => isPermissionRequest(response.request()));
  await ownRow(member).getByRole("button", { name: "Check request", exact: true }).click();
  assert.equal((await (await declineChecked).json()).status, "denied");
  await ownRow(member).locator("[data-permission-request-status]").filter({ hasText: "The request was declined. Your permissions are unchanged." }).waitFor();
  assert.deepEqual(f.permissions("requester"), ["accept_work"], "decline keeps previously granted access");
  assert.equal(f.pending().length, 0);
});

test("a lost committed response retries the same permission request without a duplicate", { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.login("requester");
  const held = f.hold(), committed = deferred(), sent = [];
  await page.route(`**${requestPath}`, async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length !== 1) return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    committed.resolve();
    await held.promise;
    await route.abort("failed");
  });
  await openMemberProfile(page, "requester");
  await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).dblclick();
  await committed.promise;
  assert.equal(sent.length, 1, "an impatient double click submits once");
  assert.equal(f.pending().length, 1, "the server committed before the response was lost");
  const sequence = f.store.room("commons").sequence;
  held.resolve();
  const retry = ownRow(page).getByRole("button", { name: "Retry request", exact: true });
  await retry.waitFor();
  const reply = page.waitForResponse(response => isPermissionRequest(response.request()));
  await retry.click();
  const response = await reply;
  assert.equal(response.status(), 201);
  const recovered = await response.json();
  await retry.waitFor({ state: "detached" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].requestId, sent[0].requestId);
  assert.ok(sent[0].requestId);
  assert.deepEqual(sent[1].permissions, sent[0].permissions);
  assert.equal(recovered.requestId, sent[0].requestId);
  assert.equal(f.pending().length, 1);
  assert.equal(f.store.room("commons").sequence, sequence, "recovering a committed request appends no duplicate event");
  assert.deepEqual(f.permissions("requester"), []);
});

test("a late permission-request response cannot move request state into a different member's session", { timeout: 60000 }, async t => {
  const f = await setup(t), page = await f.login("requester");
  const held = f.hold(), committed = deferred();
  let firstRequest;
  await page.route(`**${requestPath}`, async route => {
    if (firstRequest) return route.continue();
    firstRequest = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    committed.resolve();
    await held.promise;
    await route.fulfill({ response });
  });
  await openMemberProfile(page, "requester");
  await ownRow(page).getByRole("button", { name: "Ask to take work", exact: true }).click();
  await committed.promise;
  await clickChrome(page, "#signout-button");
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixtureInPlace(page, f.store, f.keys.other);
  await openMemberProfile(page, "other");
  const delivered = page.waitForResponse(response => isPermissionRequest(response.request()));
  held.resolve(); await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await ownRow(page, "other").getByRole("button", { name: "Ask to take work", exact: true }).count(), 1);
  assert.equal(await ownRow(page, "other").getByRole("button", { name: "Retry request", exact: true }).count(), 0);
  assert.equal(await page.locator("#attention-list > li").count(), 0);
  const otherRequest = await ask(page, "other");
  assert.equal(otherRequest.memberId, "other");
  assert.notEqual(otherRequest.requestId, firstRequest.requestId);
  assert.deepEqual(f.pending().map(request => request.memberId).sort(), ["other", "requester"]);
  assert.deepEqual(f.permissions("other"), []);
});
