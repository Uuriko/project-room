import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createRoomServer } from "../server/http.mjs";

test("requester cancel removes a pending access request from the owner queue", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-cancel-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  const other = store.identities.create("Other Agent");
  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_cancel"
  });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const postCancel = (identityId, secret) => fetch(`${origin}/api/access-requests/ar_cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ identityId })
  });

  // Both IDs are room-visible. Supplying them is not proof of ownership.
  const publicEvent = JSON.parse(store.db.prepare("SELECT body FROM events WHERE json_extract(body,'$.type')='access.requested' LIMIT 1").get().body);
  assert.equal(publicEvent.data.identityId, identity.identityId);
  assert.equal(publicEvent.data.requestId, "ar_cancel");
  for (const secret of [undefined, other.secret]) {
    const forged = await postCancel(identity.identityId, secret);
    assert.equal(forged.status, 401);
    assert.equal(requests.status("ar_cancel", identity.identityId).status, "pending");
  }
  const revoked = store.identities.create("Revoked Requester");
  requests.request("commons", { identityId: revoked.identityId, displayName: "Revoked Requester", requestId: "ar_revoked", requestedPermissions: [] });
  store.identities.revoke(revoked.identityId, revoked.secret);
  const revokedReply = await fetch(`${origin}/api/access-requests/ar_revoked`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${revoked.secret}` },
    body: JSON.stringify({ identityId: revoked.identityId })
  });
  assert.equal(revokedReply.status, 401);
  assert.equal(requests.status("ar_revoked", revoked.identityId).status, "pending");
  const stranger = await postCancel(other.identityId, other.secret);
  assert.equal(stranger.status, 404);
  assert.equal(requests.status("ar_cancel", identity.identityId).status, "pending");

  const current = store.identities.rotate(identity.identityId, identity.secret);
  assert.equal((await postCancel(identity.identityId, identity.secret)).status, 401);
  assert.equal(requests.status("ar_cancel", identity.identityId).status, "pending");
  const cancelled = await postCancel(identity.identityId, current.secret);
  assert.equal(cancelled.status, 200);
  const body = await cancelled.json();
  assert.equal(body.status, "cancelled");
  assert.equal(body.requestId, "ar_cancel");
  assert.equal(requests.list(ownerToken, "commons").some(row => row.requestId === "ar_cancel"), false);
  const withdrawn = requests.list(ownerToken, "commons", { status: "cancelled" });
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].requestId, "ar_cancel");
  assert.equal(withdrawn[0].decisionNote, "withdrawn by requester");

  const again = await postCancel(identity.identityId, current.secret);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "cancelled");
  assert.throws(
    () => requests.decide(ownerToken, "commons", "ar_cancel", { decision: "approve" }),
    error => error.status === 409
  );
});

test("direct link closes the identity's pending access request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-settle-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Already Admitted");
  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Already Admitted",
    requestedPermissions: ["accept_work"],
    requestId: "ar_direct"
  });
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId,
    permissions: ["accept_work"]
  });
  assert.equal(requests.list(ownerToken, "commons").length, 0);
  const settled = requests.list(ownerToken, "commons", { status: "approved" });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].requestId, "ar_direct");
  assert.equal(settled[0].decisionNote, "closed because this identity was linked directly");
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("approving an already-linked identity records the decision without a second grant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-already-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Granted First");
  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Granted First",
    requestedPermissions: ["manage_members"],
    requestId: "ar_already"
  });
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId,
    permissions: ["accept_work"],
    settleAccessRequests: false
  });
  const before = store.roomAuthority("commons").members[identity.identityId].permissions;
  const decided = requests.decide(ownerToken, "commons", "ar_already", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.alreadyMember, true);
  assert.equal(decided.decisionNote, "already a member; request closed without a second grant");
  assert.deepEqual(decided.grantedPermissions, before);
  assert.deepEqual(store.roomAuthority("commons").members[identity.identityId].permissions, before);
  assert.equal(requests.list(ownerToken, "commons").length, 0);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
