// People Friend chrome: Friend → Proposed → Accept → Friends + peer DM → Revoke.
// A peer DM before the bond is active fails with no_bond, then bond_pending.
// No scopes picker. Real browser + local HTTP service; disposable identities.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { expandSigninMore } from "./auth-signin.mjs";

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body)
});

async function jsonOf(res) {
  const body = await res.json();
  return { status: res.status, body };
}

test("People Friend control proposes without scopes, accepts, messages, and refuses until active", { timeout: 180000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-friend-ui-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const muse = store.identities.create("Muse");
  const quill = store.identities.create("Quill");
  const roomId = "friend-ui-room";
  const created = await post(origin, "/api/agent-rooms", {
    roomId, title: "Friends", purpose: "Friend chrome", kind: "personal", displayName: "Muse"
  }, muse.secret);
  assert.equal(created.status, 201);
  const requestId = randomUUID();
  const asked = await post(origin, "/api/access-requests", {
    roomId, identityId: quill.identityId, displayName: "Quill",
    requestedPermissions: ["accept_work"], note: null, requestId
  });
  assert.equal(asked.status, 201);
  const decided = await post(origin, `/api/rooms/${roomId}/access-requests/${requestId}/decide`, {
    decision: "approve", permissions: ["accept_work"], note: null
  }, muse.secret);
  assert.equal(decided.status, 200);
  const quillMemberId = (await decided.json()).memberId;
  const memberIdFor = identityId => store.db.prepare(
    "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?"
  ).get(roomId, identityId).memberId;
  const museMemberId = memberIdFor(muse.identityId);

  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-features=LocalNetworkAccessChecks"],
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {})
  });

  const command = (secret, type, data) => post(origin, `/api/rooms/${roomId}/commands`, {
    id: randomUUID(), type, data
  }, secret);
  const early = await jsonOf(await command(muse.secret, "dm.posted", {
    to: quill.identityId, messageId: randomUUID(), body: "too soon"
  }));
  assert.equal(early.status, 403);
  assert.equal(early.body.error.code, "no_bond");
  assert.match(early.body.hint, /bond\.propose/);

  const signIn = async identity => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error?.message ?? error)));
    await page.goto(origin);
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    await expandSigninMore(page);
    await page.locator('[name="identityId"]').fill(identity.identityId);
    await page.locator('[name="secret"]').fill(identity.secret);
    await page.locator('[data-agent-form="credentials"] button[type="submit"]').click();
    await page.locator(`[data-room-id="${roomId}"]`).click();
    await page.locator("#main").waitFor({ state: "visible" });
    if (!(await page.locator("#people-panel").evaluate(node => node.open))) {
      await page.locator("#people-panel > summary").click();
    }
    return { page, errors };
  };
  const row = (page, memberId) => page.locator(`#presence-list .presence-member[data-member-record-id="${memberId}"]`);

  const museUi = await signIn(muse);
  const quillUi = await signIn(quill);
  const museRow = row(museUi.page, quillMemberId);
  const quillRow = row(quillUi.page, museMemberId);
  await museRow.locator('[data-friend-action="propose"]').waitFor();
  await quillRow.locator('[data-friend-action="propose"]').waitFor();
  assert.equal(await museUi.page.locator("#presence-list input, #presence-list select, #presence-list [data-friend-action='dm']").count(), 0);
  assert.equal(/scope/i.test(await museUi.page.locator("#presence-list").innerText()), false);
  assert.equal(await museRow.locator('[data-friend-action="accept"]').count(), 0);

  const proposedRequest = museUi.page.waitForRequest(request =>
    request.method() === "POST" && request.url().includes(`/api/rooms/${roomId}/commands`));
  await museRow.locator('[data-friend-action="propose"]').click();
  const proposedBody = (await proposedRequest).postDataJSON();
  assert.equal(proposedBody.type, "bond.propose");
  assert.deepEqual(proposedBody.data, { to: quill.identityId });
  assert.equal(Object.hasOwn(proposedBody.data, "scopes"), false);
  await museRow.locator('.friend-chip[data-friend-state="outgoing"]').waitFor();
  assert.equal(await museRow.locator('[data-friend-action="dm"]').count(), 0);
  assert.equal(await museRow.locator(".friend-chip").innerText(), "Proposed");

  const pending = await jsonOf(await command(muse.secret, "dm.posted", {
    to: quill.identityId, messageId: randomUUID(), body: "still pending"
  }));
  assert.equal(pending.status, 403);
  assert.equal(pending.body.error.code, "bond_pending");
  assert.match(pending.body.hint, /bond\.accept/);

  await quillRow.locator('.friend-chip[data-friend-state="incoming"]').waitFor();
  assert.equal(await quillRow.locator(".friend-chip").innerText(), "Proposed");
  const acceptRequest = quillUi.page.waitForRequest(request =>
    request.method() === "POST" && request.url().includes(`/api/rooms/${roomId}/commands`)
    && request.postDataJSON()?.type === "bond.accept");
  await quillRow.locator('[data-friend-action="accept"]').click();
  const acceptBody = (await acceptRequest).postDataJSON();
  assert.equal(acceptBody.type, "bond.accept");
  assert.equal(typeof acceptBody.data.bondId, "string");
  assert.deepEqual(Object.keys(acceptBody.data), ["bondId"]);

  await museRow.locator('.friend-chip[data-friend-state="active"]').waitFor();
  assert.equal(await museRow.locator(".friend-chip").innerText(), "Friends");
  await museRow.locator('[data-friend-action="dm"]').click();
  await museUi.page.locator("#friend-dm-dialog").waitFor({ state: "visible" });
  await museUi.page.locator("#friend-dm-input").fill("hello friend");
  await museUi.page.locator("#friend-dm-form button[type=submit]").click();
  await museUi.page.locator("#friend-dm-list").getByText("hello friend").waitFor();

  await quillRow.locator('[data-friend-action="dm"]').click();
  await quillUi.page.locator("#friend-dm-list").getByText("hello friend").waitFor();

  const revoked = await jsonOf(await command(quill.secret, "bond.revoke", {
    bondId: acceptBody.data.bondId
  }));
  assert.equal(revoked.status, 201);
  await museUi.page.locator("#friend-dm-input").fill("after revoke");
  await museUi.page.locator("#friend-dm-form button[type=submit]").click();
  await museUi.page.locator("#friend-dm-status").getByText(/revoked/i).waitFor();
  assert.equal(await museUi.page.locator("#main").isVisible(), true);
  assert.equal(await museUi.page.locator("#auth-panel").isHidden(), true);
  await museRow.locator('[data-friend-action="propose"]').waitFor();
  assert.equal(museUi.errors.length, 0, museUi.errors.join("\n"));
  assert.equal(quillUi.errors.length, 0, quillUi.errors.join("\n"));
});
