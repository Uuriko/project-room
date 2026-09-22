import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
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

test("an additional agent admin issues usable human and agent invitations until its grant changes", t => {
  const f = fixture(t), identity = f.store.identities.create("Additional admin");
  f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Additional admin");
  const change = permissions => f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: identity.identityId, expectedMemberRevision: f.store.room("commons").state.members[identity.identityId].revision, permissions, active: true } });
  change(["manage_members"]);
  const linkToken = randomBytes(32).toString("base64url");
  const minted = f.store.shareLinks.create(identity.secret, "commons", { ...f.details, requestId: randomUUID(), linkToken, maxJoins: 3, expectedMemberRevision: 1 }, null);
  assert.equal(minted.link.status, "active");
  const slot = f.store.createAccountSessionSlot();
  f.store.shareLinks.join(slot.token, linkToken, { displayName: "Human", redemptionId: randomUUID(), expectedSessionRevision: 0, expectedSessionBinding: slot.session.sessionBinding });
  const peer = f.store.identities.create("Peer");
  f.store.shareLinks.joinAgent(peer.secret, linkToken, "Peer");
  assert.equal(f.store.shareLinks.preview(linkToken).link.remainingJoins, 1);
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  change([]);
  assert.throws(() => f.store.shareLinks.preview(linkToken), { code: "link_unavailable" });
  assert.throws(() => f.store.shareLinks.list(identity.secret, "commons", null), { code: "access_denied" });
  assert.equal(f.store.room("commons").state.members[identity.identityId].active, true);
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

test("#657: a lost join response is recoverable with the same redemption id after restoring the session", t => {
  const f = fixture(t), guest = f.guest("UX Probe");
  const stale = f.store.accountSessionSlot(guest.slot.token);
  const committed = guest.accept();
  assert.equal(committed.duplicate, false);
  // The naive retry with the stale pre-join session cannot work: the committed
  // join bumped the slot revision and binding.
  assert.throws(() => f.store.shareLinks.join(guest.slot.token, f.linkToken, { displayName: "UX Probe", redemptionId: guest.redemptionId,
    expectedSessionRevision: stale.sessionRevision, expectedSessionBinding: stale.sessionBinding }),
    { code: "session_binding_changed" });
  // Restore first, then re-issue the same redemption id: the server resolves it
  // idempotently and returns the credential instead of double-joining.
  const restored = f.store.accountSessionSlot(guest.slot.token);
  assert.equal(restored.sessionRevision, stale.sessionRevision + 1);
  const recovered = f.store.shareLinks.join(guest.slot.token, f.linkToken, { displayName: "UX Probe", redemptionId: guest.redemptionId,
    expectedSessionRevision: restored.sessionRevision, expectedSessionBinding: restored.sessionBinding });
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.roomId, "commons");
  assert.equal(recovered.session.member.kind, "human");
  assert.equal(recovered.session.account.id, committed.session.account.id);
  const joins = f.store.db.prepare("SELECT COUNT(*) c FROM share_link_joins WHERE redemption_id=?").get(guest.redemptionId).c;
  assert.equal(joins, 1, "the recovery must not double-join");
  assert.equal(Object.keys(f.store.room("commons").state.members).filter(m => m.startsWith("guest-")).length, 1);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
});

test("HTTP share-link administration refuses non-owner bearer keys; owner identity bearer, room-key and account browser sessions still work", async t => {
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

// The room owner on its agent identity bearer mints human share links: the
// issuer is recorded with a null account, and the link works end to end.
function agentOwnerFixture(t) {
  const f = fixture(t);
  const identity = f.store.identities.create("Owning Agent");
  f.store.identities.link(f.ownerKey, "commons", {
    identityId: identity.identityId, displayName: "Owning Agent", permissions: ["accept_work"]
  });
  new AgentRooms(f.store).transfer(f.ownerKey, "commons", { toMemberId: identity.identityId });
  assert.equal(f.store.roomAuthority("commons").ownerId, identity.identityId);
  const revision = f.store.roomAuthority("commons").members[identity.identityId].revision;
  return { ...f, identity, ownerRevision: revision };
}

test("room owner on its agent identity Bearer <redacted> a human share link with a null issuer account", t => {
  const f = agentOwnerFixture(t);
  const linkToken = randomBytes(32).toString("base64url");
  const details = { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: f.ownerRevision };
  const created = f.store.shareLinks.create(f.identity.secret, "commons", details, null);
  assert.equal(created.duplicate, false);
  assert.equal(created.link.status, "active");
  const row = f.store.db.prepare("SELECT * FROM share_links WHERE id=?").get(created.link.id);
  assert.equal(row.issuer_account_id, null);
  assert.equal(row.issuer_auth_epoch, null);
  assert.equal(row.issuer_member_id, f.identity.identityId);
  // Exact retries are idempotent for the accountless issuer.
  const again = f.store.shareLinks.create(f.identity.secret, "commons", details, null);
  assert.equal(again.duplicate, true);
  assert.equal(again.link.id, created.link.id);
  assert.throws(() => f.store.shareLinks.create(f.identity.secret, "commons", { ...details, maxJoins: 3 }, null),
    { code: "idempotency_conflict" });
  // The owner lists and cancels on the same bearer.
  assert.equal(f.store.shareLinks.list(f.identity.secret, "commons", null).links.length, 2);
  const cancelled = f.store.shareLinks.cancel(f.identity.secret, "commons", created.link.id, null);
  assert.equal(cancelled.link.status, "cancelled");
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
});

test("a human guest joins through an agent-issued link and the invitation audit stays consistent", t => {
  const f = agentOwnerFixture(t);
  const linkToken = randomBytes(32).toString("base64url");
  const created = f.store.shareLinks.create(f.identity.secret, "commons",
    { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: f.ownerRevision }, null);
  const slot = f.store.createAccountSessionSlot();
  const joined = f.store.shareLinks.join(slot.token, linkToken, { displayName: "Agent-invited Guest",
    redemptionId: randomUUID(), expectedSessionRevision: 0, expectedSessionBinding: slot.session.sessionBinding });
  assert.equal(joined.session.member.displayName, "Agent-invited Guest");
  assert.equal(joined.session.member.role, "guest");
  const invitation = f.store.db.prepare("SELECT * FROM membership_invitations WHERE id=(SELECT invitation_id FROM share_link_joins WHERE link_id=?)").get(created.link.id);
  assert.equal(invitation.issuer_account_id, null);
  assert.equal(invitation.issuer_account_auth_epoch, null);
  assert.equal(invitation.issuer_member_id, f.identity.identityId);
  assert.equal(invitation.status, "accepted");
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  assert.equal(f.store.shareLinks.list(f.identity.secret, "commons", null).links.find(link => link.id === created.link.id).joins, 1);
});

test("HTTP: owner and appointed agent admin can manage shared invites; ordinary agents cannot", async t => {
  const f = agentOwnerFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", headers = {}, data } = {}) => fetch(origin + path, { method,
    headers: { Origin: origin, ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const ownerBearer = { Authorization: `Bearer ${f.identity.secret}` };
  const create = { requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000, maxJoins: 1, expectedMemberRevision: f.ownerRevision };
  const listed = await request("/api/rooms/commons/share-links", { headers: ownerBearer });
  assert.equal(listed.status, 200);
  const made = await request("/api/rooms/commons/share-links", { method: "POST", headers: ownerBearer, data: create });
  assert.equal(made.status, 201);
  const linkId = (await made.json()).link.id;
  // The link is active and guest-joinable.
  assert.equal((await (await request("/api/rooms/commons/share-links", { headers: ownerBearer })).json()).links
    .find(link => link.id === linkId).status, "active");
  const cancelled = await request("/api/rooms/commons/share-links-cancel", { method: "POST", headers: ownerBearer, data: { linkId } });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).link.status, "cancelled");
  // A work grant alone never permits membership administration.
  const other = f.store.identities.create("Other Agent");
  f.store.identities.link(f.ownerKey, "commons", {
    identityId: other.identityId, displayName: "Other Agent", permissions: ["accept_work", "steer", "verify"]
  });
  const otherBearer = { Authorization: `Bearer ${other.secret}` };
  for (const args of [
    ["/api/rooms/commons/share-links", {}],
    ["/api/rooms/commons/share-links", { method: "POST", data: { ...create, requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url") } }],
    ["/api/rooms/commons/share-links-cancel", { method: "POST", data: { linkId } }],
  ]) {
    const response = await request(args[0], { ...args[1], headers: otherBearer });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "access_denied");
  }
  const change = permissions => f.store.command(f.identity.secret, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: other.identityId, expectedMemberRevision: f.store.room("commons").state.members[other.identityId].revision, permissions, active: true } });
  change(["manage_members"]);
  assert.equal((await request("/api/rooms/commons/share-links", { headers: otherBearer })).status, 200);
  const adminLink = await request("/api/rooms/commons/share-links", { method: "POST", headers: otherBearer,
    data: { ...create, requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"), expectedMemberRevision: 1 } });
  assert.equal(adminLink.status, 201);
  const adminId = (await adminLink.json()).link.id;
  assert.equal((await request("/api/rooms/commons/share-links-cancel", { method: "POST", headers: otherBearer, data: { linkId: adminId } })).status, 200);
  change([]);
  assert.equal((await request("/api/rooms/commons/share-links", { headers: otherBearer })).status, 403);
});

test("an agent-issued link goes authority_changed when the issuer loses ownership or is deactivated", t => {
  const f = agentOwnerFixture(t);
  const linkToken = randomBytes(32).toString("base64url");
  const created = f.store.shareLinks.create(f.identity.secret, "commons",
    { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: f.ownerRevision }, null);
  assert.equal(created.link.status, "active");
  // Ownership moves back to the human owner: the agent keeps membership but is
  // no longer the owner, so its link loses authority.
  new AgentRooms(f.store).transfer(f.identity.secret, "commons", { toMemberId: "owner" });
  assert.equal(f.store.roomAuthority("commons").ownerId, "owner");
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons", null).links.find(link => link.id === created.link.id).status, "authority_changed");
  assert.throws(() => f.store.shareLinks.preview(linkToken), { code: "link_unavailable" });
});

test("v34 databases migrate share-link and invitation history to v36 with issuer columns nullable", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-share-migrate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "room.sqlite");
  // Build a v34 database the long way: create it with the new code, then flip
  // the schema back to the v34 shape (NOT NULL issuer columns, no agent
  // partial indexes) and the version pragma, with representative rows.
  const now = Date.now();
  const legacy = new RoomStore(filename, { now: () => now });
  legacy.initialize(initialRoom());
  const ownerKey = legacy.issueAccessKey("commons", "owner");
  const linkToken = randomBytes(32).toString("base64url");
  legacy.shareLinks.create(ownerKey, "commons",
    { requestId: randomUUID(), linkToken, expiresAt: now + 3600000, maxJoins: 2, expectedMemberRevision: 0 }, null);
  const slot = legacy.createAccountSessionSlot();
  legacy.shareLinks.join(slot.token, linkToken, { displayName: "Legacy Guest", redemptionId: randomUUID(),
    expectedSessionRevision: 0, expectedSessionBinding: slot.session.sessionBinding });
  const shareCount = legacy.db.prepare("SELECT count(*) n FROM share_links").get().n;
  const invitationCount = legacy.db.prepare("SELECT count(*) n FROM membership_invitations").get().n;
  const joinCount = legacy.db.prepare("SELECT count(*) n FROM share_link_joins").get().n;
  legacy.close();
  // Downgrade the file to the v34 shape: NOT NULL issuer columns, no agent
  // partial indexes, v34 writer-fence triggers. Parents rebuild before
  // children (FK-safe order). The renames carry triggers/indexes away; the
  // v35 migration recreates them.
  const { DatabaseSync } = await import("node:sqlite");
  const { fenceDefinitions } = await import("../server/writer-fence.mjs");
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys=OFF");
  const tables = ["share_links", "membership_invitations", "membership_invitation_events", "membership_invitation_journal", "share_link_joins"];
  // Capture original DDL before any rename rewrites FK targets.
  const original = Object.fromEntries(tables.map(table =>
    [table, db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql]));
  for (const table of tables) {
    const downgraded = original[table]
      .replace("issuer_account_id TEXT REFERENCES accounts(id)", "issuer_account_id TEXT NOT NULL REFERENCES accounts(id)")
      .replace("issuer_auth_epoch INTEGER,", "issuer_auth_epoch INTEGER NOT NULL,")
      .replace("issuer_account_auth_epoch INTEGER,", "issuer_account_auth_epoch INTEGER NOT NULL,");
    // Only share_links and membership_invitations carry issuer columns.
    if (table !== "share_link_joins" && table !== "membership_invitation_events" && table !== "membership_invitation_journal"
      && downgraded === original[table]) throw new Error(`downgrade regex missed ${table}`);
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_downgrade`);
    db.exec(downgraded);
    db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_downgrade`);
    db.exec(`DROP TABLE ${table}_downgrade`);
  }
  // Swap the v35 writer fence for the v34 one a real v34 database would carry.
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all()) {
    db.exec(`DROP TRIGGER ${row.name}`);
  }
  for (const { sql } of fenceDefinitions(34)) db.exec(sql);
  db.exec("PRAGMA user_version=34");
  db.close();
  // Reopening migrates to v36 (via v35) and preserves every row and the audit.
  const store = new RoomStore(filename, { now: () => now });
  t.after(() => store.close());
  assert.equal(store.storagePlatform.version(store.db), 36);
  assert.equal(store.db.prepare("SELECT count(*) n FROM share_links").get().n, shareCount);
  assert.equal(store.db.prepare("SELECT count(*) n FROM membership_invitations").get().n, invitationCount);
  assert.equal(store.db.prepare("SELECT count(*) n FROM share_link_joins").get().n, joinCount);
  assert.equal(store.shareLinks.list(ownerKey, "commons", null).links[0].status, "active");
  assert.equal(store.shareLinks.list(ownerKey, "commons", null).links[0].joins, 1);
  assert.equal(store.verifyInvitationAudit().consistent, true);
  assert.doesNotThrow(() => store.shareLinks.verify());
  // The nullable columns now accept an agent issuer end to end.
  const identity = store.identities.create("Migrated Owner");
  store.identities.link(ownerKey, "commons", { identityId: identity.identityId, displayName: "Migrated Owner", permissions: ["accept_work"] });
  new AgentRooms(store).transfer(ownerKey, "commons", { toMemberId: identity.identityId });
  const agentToken = randomBytes(32).toString("base64url");
  const agentCreated = store.shareLinks.create(identity.secret, "commons",
    { requestId: randomUUID(), linkToken: agentToken, expiresAt: now + 3600000, maxJoins: 1,
      expectedMemberRevision: store.roomAuthority("commons").members[identity.identityId].revision }, null);
  assert.equal(agentCreated.link.status, "active");
});

test("Google login rotates a previously invited session without deleting immutable join history", t => {
  const f = fixture(t), guest = f.guest();
  guest.accept();
  const before = f.store.db.prepare("SELECT * FROM share_link_joins").all();
  const slot = f.store.accountSessionSlot(guest.slot.token);
  f.store.createAccount("google:123456789", "google-oauth");
  const loggedIn = f.store.loginAccountSessionWithMethod(guest.slot.token, "google:123456789", slot.sessionRevision,
    { method: { kind: "oauth", ref: "google:123456789" }, rotateSlot: true });
  assert.equal(f.store.authenticateAccountSession(loggedIn.token).account.id, "google:123456789");
  assert.throws(() => f.store.accountSessionSlot(guest.slot.token), { code: "unauthenticated" });
  assert.deepEqual(f.store.db.prepare("SELECT * FROM share_link_joins").all(), before);
  assert.doesNotThrow(() => f.store.createAccountSessionSlot());
  f.setNow(f.store.now() + 31 * 86400000);
  assert.doesNotThrow(() => f.store.createAccountSessionSlot());
  assert.deepEqual(f.store.db.prepare("SELECT * FROM share_link_joins").all(), before);
});

test("one invitation admits a human and an agent into the same bounded read/chat audience", t => {
  const f = fixture(t), identity = f.store.identities.create("Peer agent");
  const joined = f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Peer agent");
  assert.deepEqual(joined.permissions, []);
  assert.equal(f.store.authenticate(identity.secret, "commons").member.kind, "agent");
  f.guest("Human").accept();
  const link = f.store.shareLinks.list(f.ownerKey, "commons").links[0];
  assert.equal(link.joins, 2); assert.equal(link.status, "full");
  assert.throws(() => f.store.shareLinks.joinAgent(f.store.identities.create("Third").secret, f.linkToken, "Third"), { code: "link_unavailable" });
  assert.throws(() => f.guest("Third human").accept(), { code: "link_unavailable" });
  const sequence = f.store.room("commons").sequence;
  assert.equal(f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Renaming does not replace identity").duplicate, true);
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.doesNotThrow(() => f.store.shareLinks.verify());
  assert.equal(f.store.verifyInvitationAudit().consistent, true);
  const state = JSON.stringify(f.store.room("commons").state);
  assert.equal(state.includes(identity.secret), false); assert.equal(state.includes(f.linkToken), false);
});

test("human joins consume the same capacity as agent joins and cancellation preserves only existing access", t => {
  const f = fixture(t); f.guest().accept();
  const identity = f.store.identities.create("Agent");
  f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent");
  f.store.shareLinks.cancel(f.ownerKey, "commons", f.result.link.id);
  assert.equal(f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent").duplicate, true);
  f.store.identities.unlink(f.ownerKey, "commons", identity.identityId);
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent"), { code: "access_ended" });
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons").links[0].joins, 2);
});

for (const reason of ["expired", "cancelled", "authority", "archived", "verified-only"]) test(`shared agent invitation refuses ${reason} without partial membership`, t => {
  const f = fixture(t), identity = f.store.identities.create("Agent");
  if (reason === "expired") f.setNow(f.details.expiresAt + 1);
  if (reason === "cancelled") f.store.shareLinks.cancel(f.ownerKey, "commons", f.result.link.id);
  if (reason === "authority") f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: "member.access_changed", data: { memberId: "owner", expectedMemberRevision: 0, permissions: f.store.room("commons").state.members.owner.permissions, active: true } });
  if (reason === "archived") f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: "room.archived", data: { reason: "Test" } });
  if (reason === "verified-only") f.store.agentPlugin.roomVerificationPolicy = () => ({ requireVerified: true });
  const sequence = f.store.room("commons").sequence;
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent"));
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM identity_links WHERE identity_id=?").get(identity.identityId).n, 0);
});

test("shared agent admission requires a live identity and rolls back failed membership writes", t => {
  const f = fixture(t), identity = f.store.identities.create("Agent"), sequence = f.store.room("commons").sequence;
  assert.throws(() => f.store.shareLinks.joinAgent(null, f.linkToken, "Agent"), { status: 401 });
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, 'a'.repeat(43), "Agent"), { code: "link_unavailable" });
  f.store.db.exec("CREATE TRIGGER fail_shared_agent BEFORE INSERT ON identity_links BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent"), /fixture failure/);
  assert.equal(f.store.room("commons").sequence, sequence);
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons").links[0].joins, 0);
});


test("revoked agent identities cannot recover or consume a shared invitation", t => {
  const f = fixture(t), identity = f.store.identities.create("Agent");
  f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent");
  f.store.identities.revoke(identity.identityId, identity.secret);
  assert.throws(() => f.store.shareLinks.joinAgent(identity.secret, f.linkToken, "Agent"), { status: 401 });
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons").links[0].joins, 1);
});


test("same join retried with a lost cookie cannot mint a second guest or use the request ID as a credential", t => {
  const f = fixture(t), original = f.guest("Jill"), joined = original.accept();
  const before = f.store.room("commons").sequence;
  const retry = f.guest("Jill");
  for (let n = 0; n < 4; n++) {
    const session = f.store.accountSessionSlot(retry.slot.token);
    assert.throws(() => f.store.shareLinks.join(retry.slot.token, f.linkToken, {
      displayName: "Jill", redemptionId: original.redemptionId,
      expectedSessionRevision: session.sessionRevision, expectedSessionBinding: session.sessionBinding
    }), { code: "join_session_lost" });
  }
  assert.equal(f.store.room("commons").sequence, before);
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons").links[0].joins, 1);
  assert.throws(() => f.store.authenticateAccountSession(retry.slot.token), { code: "unauthenticated" });
  assert.equal(original.accept().session.member.id, joined.session.member.id);
  // Names are not identity: a different person choosing the same name may join.
  const different = retry.accept();
  assert.notEqual(different.session.member.id, joined.session.member.id);
});

test("existing guest reopens a full invitation using a new request ID without another join", t => {
  const f = fixture(t), first = f.guest("Jill");
  const joined = first.accept(); f.guest("Other").accept();
  const session = f.store.accountSessionSlot(first.slot.token);
  const resumed = f.store.shareLinks.join(first.slot.token, f.linkToken, { displayName: "Jill", redemptionId: randomUUID(),
    expectedSessionRevision: session.sessionRevision, expectedSessionBinding: session.sessionBinding });
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.session.member.id, joined.session.member.id);
  assert.equal(f.store.shareLinks.list(f.ownerKey, "commons").links[0].joins, 2);
});

test("closed-link preview only admits a bound active member without creating or redeeming anything", t => {
  const f = fixture(t), guest = f.guest(), accepted = guest.accept();
  f.guest('Other guest').accept();
  const binding = accepted.session.sessionBinding;
  const before = f.store.db.prepare('SELECT count(*) n FROM share_link_joins').get().n;
  assert.equal(f.store.shareLinks.preview(f.linkToken, guest.slot.token, binding).link.status, 'full');
  for (const [token, fence] of [[null, null], [guest.slot.token, null], [guest.slot.token, 'wrong-binding']]) {
    assert.throws(() => f.store.shareLinks.preview(f.linkToken, token, fence), { code: 'link_unavailable' });
  }
  const outsider = f.store.createAccount('Outsider', 'audit');
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(outsider.id), 0);
  assert.throws(() => f.store.shareLinks.preview(f.linkToken, slot.token, session.sessionBinding), { code: 'link_unavailable' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM share_link_joins').get().n, before);
  f.store.command(f.ownerKey, 'commons', { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: accepted.session.member.id, expectedMemberRevision: accepted.session.member.revision, permissions: [], active: false } });
  assert.throws(() => f.store.shareLinks.preview(f.linkToken, guest.slot.token, binding), { code: 'link_unavailable' });
});
