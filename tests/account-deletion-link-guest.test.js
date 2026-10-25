// R365-1: deleting the owner's account must not hand a personal room to an
// 8-hour share-link guest. Before the fix the guest's throwaway account counts
// as an "other human owner", so the room is transferred (guest gets owner
// authority and reads history its since_join floor hid) instead of archived.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const SECRET = "pre-join-secret-r365";

test("owner deletion with a link guest present: the guest does not become owner or read pre-join history", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, headers = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(data) });
  // owner account
  const slot = f.store.createAccountSessionSlot();
  const email = "r365-owner@example.invalid";
  const res = await post("/api/auth/password/signup", { email, password: "fixture-password-r365-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(token);
  f.store.accountLogins.markEmailVerified(session.account.id, email);
  const roomId = "personal-r365";
  f.store.createAccountRoom(token, session.sessionBinding, { roomId, title: "My first room", purpose: "r365", kind: "personal", displayName: "Owner" });
  const key = f.store.issueAccessKey(roomId, "owner");
  f.store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "pre-join", body: SECRET } });
  // guest joins through a share link
  const linkToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(key, roomId, { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 5,
    expectedMemberRevision: f.store.room(roomId).state.members.owner.revision ?? 0 }, null);
  const gslot = f.store.createAccountSessionSlot();
  const gview = f.store.accountSessionSlot(gslot.token);
  const gh = { Cookie: `account_session=${gslot.token}`, "x-csrf-token": gview.csrf, "x-session-binding": gview.sessionBinding };
  const joined = await post("/api/share-links/join", { linkToken, displayName: "Riley", redemptionId: randomUUID(), expectedSessionRevision: gview.sessionRevision }, gh);
  assert.equal(joined.status, 201, await joined.clone().text());
  const guestId = Object.values(f.store.room(roomId).state.members).find(m => m.displayName === "Riley")?.id;
  assert.ok(guestId?.startsWith("guest-"), "the link guest joined");
  assert.notEqual(f.store.historyFloor(roomId, guestId), null, "since_join hides the pre-join message from the guest before deletion");
  // owner deletes the account
  const oc = { Cookie: `account_session=${token}` };
  const planned = await (await fetch(origin + "/api/account/deletion/plan", { headers: oc })).json();
  const after = f.store.authenticateAccountSession(token);
  const done = await post("/api/account/delete", { confirmationToken: planned.confirmationToken }, { ...oc, "X-CSRF-Token": after.csrf });
  assert.equal(done.status, 200, await done.clone().text());
  const state = f.store.room(roomId).state;
  assert.notEqual(state.room.ownerId, guestId, "an 8-hour link guest is not made the room owner");
  assert.notEqual(f.store.historyFloor(roomId, guestId), null, "the guest still cannot read the owner's pre-join message");
});

test("owner deletion with an upgraded link guest (has a login method): the kept guest is a valid heir", async t => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, headers = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(data) });
  // owner account
  const slot = f.store.createAccountSessionSlot();
  const email = "r365-owner2@example.invalid";
  const res = await post("/api/auth/password/signup", { email, password: "fixture-password-r365-long-enough", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(token);
  f.store.accountLogins.markEmailVerified(session.account.id, email);
  const roomId = "personal-r365-upg";
  f.store.createAccountRoom(token, session.sessionBinding, { roomId, title: "My first room", purpose: "r365", kind: "personal", displayName: "Owner" });
  const key = f.store.issueAccessKey(roomId, "owner");
  f.store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "pre-join", body: SECRET } });
  // guest joins through a share link, then keeps the account: the guest-upgrade
  // flow (POST /api/auth/guest/upgrade/confirm) links a password + verified
  // email but does not rewrite the account origin, so it stays share-link-guest.
  const linkToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(key, roomId, { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 5,
    expectedMemberRevision: f.store.room(roomId).state.members.owner.revision ?? 0 }, null);
  const gslot = f.store.createAccountSessionSlot();
  const gview = f.store.accountSessionSlot(gslot.token);
  const gh = { Cookie: `account_session=${gslot.token}`, "x-csrf-token": gview.csrf, "x-session-binding": gview.sessionBinding };
  const joined = await post("/api/share-links/join", { linkToken, displayName: "Riley", redemptionId: randomUUID(), expectedSessionRevision: gview.sessionRevision }, gh);
  assert.equal(joined.status, 201, await joined.clone().text());
  const guestId = Object.values(f.store.room(roomId).state.members).find(m => m.displayName === "Riley")?.id;
  assert.ok(guestId?.startsWith("guest-"), "the link guest joined");
  const guestAccountId = f.store.db.prepare(
    "SELECT account_id AS accountId FROM member_accounts WHERE room_id=? AND member_id=?"
  ).get(roomId, guestId)?.accountId;
  assert.ok(guestAccountId, "the guest member is bound to an account");
  const gEmail = "riley-kept@example.invalid";
  f.store.accountLogins.linkPasswordMethod(guestAccountId, { email: gEmail, verifier: "test-verifier-not-a-real-hash" });
  f.store.accountLogins.markEmailVerified(guestAccountId, gEmail);
  assert.equal(f.store.db.prepare("SELECT origin FROM accounts WHERE id=?").get(guestAccountId).origin, "share-link-guest", "the kept guest keeps its origin");
  // owner deletes the account
  const oc = { Cookie: `account_session=${token}` };
  const planned = await (await fetch(origin + "/api/account/deletion/plan", { headers: oc })).json();
  const after = f.store.authenticateAccountSession(token);
  const done = await post("/api/account/delete", { confirmationToken: planned.confirmationToken }, { ...oc, "X-CSRF-Token": after.csrf });
  assert.equal(done.status, 200, await done.clone().text());
  // A kept guest with a login method is a real human: the room transfers to it.
  const state = f.store.room(roomId).state;
  assert.equal(state.room.ownerId, guestId, "a kept (upgraded) link guest is a valid heir");
});
