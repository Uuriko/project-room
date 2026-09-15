import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AccountClient } from "../src/client.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-share-contract-")), filename = join(directory, "room.sqlite");
  let now = Date.now();
  const store = new RoomStore(filename, { now: () => now }); store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const linkToken = randomBytes(32).toString("base64url");
  const details = { requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 2, expectedMemberRevision: 0 };
  const result = store.shareLinks.create(ownerKey, "commons", details, null);
  const guest = (name = "Guest") => {
    const slot = store.createAccountSessionSlot(), redemptionId = randomUUID();
    const accept = (displayName = name) => {
      const current = store.accountSessionSlot(slot.token);
      return store.shareLinks.join(slot.token, linkToken, { displayName, redemptionId,
        expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
    };
    return { slot, accept, redemptionId };
  };
  return { store, filename, ownerKey, details, result, linkToken, guest, setNow: value => { now = value; } };
}

test("one share link creates distinct named guest identities without sharing the owner credential", t => {
  const f = fixture(t), a = f.guest("Alice"), b = f.guest("Bob");
  const first = a.accept(), second = b.accept();
  assert.notEqual(first.session.account.id, second.session.account.id);
  assert.notEqual(first.session.member.id, second.session.member.id);
  assert.equal(first.session.member.displayName, "Alice");
  assert.equal(second.session.member.role, "guest");
  assert.deepEqual(second.session.member.permissions, []);
  assert.equal(f.store.authenticate(f.ownerKey).member.id, "owner");
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons", null).links[0].joins, 2);
  const snapshot = f.store.snapshot(a.slot.token, "commons", first.session.sessionBinding);
  assert.equal(JSON.stringify(snapshot).includes(f.linkToken), false);
  assert.equal(JSON.stringify(snapshot).includes(first.session.account.id), true); // viewer ownership only
  const posted = f.store.command(a.slot.token, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { body: "Hello room" } }, first.session.sessionBinding);
  assert.equal(posted.event.actorId, first.session.member.id);
});

test("retries keep the same guest, do not consume another use, and require unchanged browser ownership", t => {
  const f = fixture(t), guest = f.guest();
  const first = guest.accept(), again = guest.accept();
  assert.equal(again.duplicate, true); assert.equal(again.session.member.id, first.session.member.id);
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons", null).links[0].joins, 1);
  assert.throws(() => guest.accept("Changed name"), { code: "join_changed" });
  f.store.logoutAccountSession(guest.slot.token, first.session.sessionRevision);
  assert.throws(() => guest.accept(), { code: "join_changed" });
});

test("join limits, expiry, cancellation and current inviter authority bound future joins", t => {
  const f = fixture(t); f.guest().accept(); f.guest().accept();
  assert.throws(() => f.guest().accept(), { code: "link_unavailable" });
  assert.throws(() => f.store.shareLinks.preview(f.linkToken), { code: "link_unavailable" });
  const newToken = randomBytes(32).toString("base64url");
  const created = f.store.shareLinks.create(f.ownerKey, "commons", { ...f.details, requestId: randomUUID(), linkToken: newToken }, null);
  f.store.shareLinks.cancel(f.ownerKey, "commons", created.link.id, null);
  assert.throws(() => f.store.shareLinks.preview(newToken), { code: "link_unavailable" });
  assert.equal(f.store.shareLinks.cancel(f.ownerKey, "commons", created.link.id, null).link.status, "cancelled");
  f.setNow(f.details.expiresAt);
  assert.throws(() => f.store.shareLinks.preview(f.linkToken), { code: "link_unavailable" });
});

test("cancelling a link preserves existing membership and committed audit across restart", t => {
  const f = fixture(t), guest = f.guest(), accepted = guest.accept();
  f.store.shareLinks.cancel(f.ownerKey, "commons", f.result.link.id, null);
  assert.equal(f.store.authenticateAccountSession(guest.slot.token, "commons").member.id, accepted.session.member.id);
  const reopened = new RoomStore(f.filename);
  try {
    assert.equal(reopened.authenticateAccountSession(guest.slot.token, "commons").member.id, accepted.session.member.id);
    assert.equal(reopened.shareLinks.list(f.ownerKey, "commons", null).links[0].status, "cancelled");
    assert.doesNotThrow(() => reopened.shareLinks.verify());
  } finally { reopened.close(); }
});

test("storage failure rolls back guest identity, session switch, membership, invitation audit and usage together", t => {
  const f = fixture(t), guest = f.guest(), before = f.store.room("commons").sequence;
  const original = f.store.appendInvitationJournal;
  f.store.appendInvitationJournal = () => { throw new Error("Simulated unavailable storage"); };
  try { assert.throws(() => guest.accept(), /unavailable storage/); }
  finally { f.store.appendInvitationJournal = original; }
  assert.equal(f.store.accountSessionSlot(guest.slot.token).sessionRevision, 0);
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM accounts WHERE origin='share-link-guest'").get().n, 0);
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons", null).links[0].joins, 0);
  assert.equal(guest.accept().duplicate, false);
});

test("existing account membership is reused and changed issuer authority invalidates a link", t => {
  const f = fixture(t), guest = f.guest(), accepted = guest.accept();
  const current = f.store.accountSessionSlot(guest.slot.token);
  const same = f.store.shareLinks.join(guest.slot.token, f.linkToken, { displayName: "Still me", redemptionId: randomUUID(), expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
  assert.equal(same.session.member.id, accepted.session.member.id);
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: 0, permissions: f.store.room("commons").state.members.owner.permissions, active: true } });
  assert.throws(() => f.store.shareLinks.preview(f.linkToken), { code: "link_unavailable" });
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons", null).links[0].status, "authority_changed");
});

test("HTTP guest flow bootstraps a stable cookie, joins without a key, restores the room and keeps link secrets private", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const fetcher = async (path, options = {}) => {
    const response = await fetch(origin + path, { ...options, headers: { Origin: origin,
      ...(options.credentials === "omit" ? {} : { Cookie: cookie }), ...options.headers } });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  };
  const client = new AccountClient({ fetcher }); await client.restore();
  const originalCookie = cookie;
  const preview = await client.request("/api/share-links/preview", { method: "POST", credentials: "omit", data: { linkToken: f.linkToken } });
  assert.equal(preview.link.role, "guest");
  const joined = await client.joinShareLink({ linkToken: f.linkToken, displayName: "Browser guest", redemptionId: randomUUID() });
  assert.equal(joined.session.member.displayName, "Browser guest"); assert.equal(cookie, originalCookie);
  assert.equal(client.session.authenticated, true);
  const room = await client.request("/api/session?room=commons", { session: client.session });
  assert.equal(room.member.id, joined.session.member.id);
  const asset = await fetcher("/src/share-links.js"); assert.equal(asset.status, 200);
  const previewResponse = await fetcher("/api/share-links/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linkToken: f.linkToken }) });
  assert.equal(previewResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(previewResponse.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(await previewResponse.json()).includes(f.linkToken), false);
});

test("a room-key owner session opens its existing identity through a link without creating another guest", t => {
  const f = fixture(t), owner = f.store.createSession(f.ownerKey), slot = f.store.createAccountSessionSlot();
  const result = f.store.shareLinks.join(slot.token, f.linkToken, { displayName: "Owner", redemptionId: randomUUID(), expectedSessionRevision: 0,
    expectedSessionBinding: slot.session.sessionBinding, revokeRoomToken: owner.token });
  assert.equal(result.roomMode, true); assert.equal(result.session.member.id, "owner");
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons", null).links[0].joins, 0);
  assert.equal(f.store.accountSessionSlot(slot.token).sessionRevision, 0);
});

test("link creation retries preserve scope and guests cannot administer invitation links", t => {
  const f = fixture(t);
  assert.equal(f.store.shareLinks.create(f.ownerKey, "commons", f.details, null).duplicate, true);
  assert.throws(() => f.store.shareLinks.create(f.ownerKey, "commons", { ...f.details, maxJoins: 4 }, null), { code: "idempotency_conflict" });
  const guest = f.guest(), accepted = guest.accept();
  assert.throws(() => f.store.shareLinks.list(guest.slot.token, "commons", accepted.session.sessionBinding), { code: "access_denied" });
  assert.throws(() => f.store.shareLinks.cancel(guest.slot.token, "commons", f.result.link.id, accepted.session.sessionBinding), { code: "access_denied" });
});

test("HTTP share-link administration refuses room bearer keys; room-key and account browser sessions still work", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", headers = {}, data } = {}) => fetch(origin + path, { method,
    headers: { Origin: origin, ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const refused = async response => { assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "access_denied"); };
  const create = { requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 3600000, maxJoins: 1, expectedMemberRevision: 0 };
  // The owner's room access key administers links at the store level, but the
  // documented HTTP contract is the signed-in account session only.
  const bearer = { Authorization: `Bearer ${f.ownerKey}` };
  await refused(await request("/api/rooms/commons/share-links", { headers: bearer }));
  await refused(await request("/api/rooms/commons/share-links", { method: "POST", headers: bearer, data: create }));
  await refused(await request("/api/rooms/commons/share-links-cancel", { method: "POST", headers: bearer, data: { linkId: f.result.link.id } }));
  // A room session token sent as a bearer credential is a bearer key too.
  const roomSession = f.store.createSession(f.ownerKey);
  await refused(await request("/api/rooms/commons/share-links", { headers: { Authorization: `Bearer ${roomSession.token}` } }));
  const links = f.store.shareLinks.list(f.ownerKey, "commons", null).links;
  assert.equal(links.length, 1, "nothing was created"); assert.equal(links[0].status, "active", "nothing was cancelled");
  // The owner's room-key browser session (cookie + CSRF), which the Room app uses, still administers links.
  const roomCookie = { Cookie: `room_session=${roomSession.token}`, "X-Session-Binding": roomSession.session.sessionBinding, "X-CSRF-Token": roomSession.session.csrf };
  const roomListed = await request("/api/rooms/commons/share-links", { headers: roomCookie });
  assert.equal(roomListed.status, 200); assert.equal((await roomListed.json()).links.length, 1);
  const roomCreated = await request("/api/rooms/commons/share-links", { method: "POST", headers: roomCookie, data: create });
  assert.equal(roomCreated.status, 201);
  // So does the owner's signed-in account session (?auth=account).
  const account = f.store.accountForMember("commons", "owner"), slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(account.id), 0);
  const cookie = { Cookie: `account_session=${slot.token}`, "X-Project-Room-Auth": "account", "X-Session-Binding": session.sessionBinding, "X-CSRF-Token": session.csrf };
  const listed = await request("/api/rooms/commons/share-links", { headers: cookie });
  assert.equal(listed.status, 200); assert.equal((await listed.json()).links.length, 2);
  const cancelled = await request("/api/rooms/commons/share-links-cancel", { method: "POST", headers: cookie, data: { linkId: (await roomCreated.json()).link.id } });
  assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).link.status, "cancelled");
  const created = await request("/api/rooms/commons/share-links", { method: "POST", headers: cookie,
    data: { ...create, requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url") } });
  assert.equal(created.status, 201);
});
