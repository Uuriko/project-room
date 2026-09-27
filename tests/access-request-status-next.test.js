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

// The poll read is the requester's only window on the owner's decision. Each
// status must carry its continuation: pending re-teaches the poll path,
// approved points at the room read, and terminal states give closed/refile
// guidance instead of a bare status string.
test("access-request poll returns status-aware next hints", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-status-next-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_next_pending"
  });
  requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"],
    requestId: "ar_next_denied"
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
  const poll = async requestId => {
    const res = await fetch(`${origin}/api/access-requests/${requestId}?identityId=${encodeURIComponent(identity.identityId)}`);
    assert.equal(res.status, 200);
    return res.json();
  };

  // Pending: re-teach the poll path and decision window.
  const pending = await poll("ar_next_pending");
  assert.equal(pending.status, "pending");
  assert.equal(pending.next.length, 1);
  assert.equal(pending.next[0].action, "poll-status");
  assert.equal(pending.next[0].method, "GET");
  assert.ok(pending.next[0].path.includes("/api/access-requests/ar_next_pending"));
  assert.ok(pending.next[0].description.includes("decision"));

  // Approved: point at the room read as the next step.
  requests.decide(ownerToken, "commons", "ar_next_pending", { decision: "approve", permissions: ["accept_work"] });
  const approved = await poll("ar_next_pending");
  assert.equal(approved.status, "approved");
  assert.equal(approved.next.length, 1);
  assert.equal(approved.next[0].action, "read-room");
  assert.equal(approved.next[0].method, "GET");
  assert.equal(approved.next[0].path, "/api/rooms/commons");
  const roomRead = await fetch(origin + approved.next[0].path, { headers: { Authorization: `Bearer ${identity.secret}` } });
  assert.equal(roomRead.status, 200);
  assert.equal((await roomRead.json()).roomId, "commons");

  // Denied: terminal guidance, no pretend continuation.
  requests.decide(ownerToken, "commons", "ar_next_denied", { decision: "deny" });
  const denied = await poll("ar_next_denied");
  assert.equal(denied.status, "denied");
  assert.equal(denied.next.length, 1);
  assert.equal(denied.next[0].action, "closed");
  assert.ok(denied.next[0].description.includes("fresh requestId"));
});
