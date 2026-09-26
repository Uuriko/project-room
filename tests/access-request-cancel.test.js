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
  const postCancel = identityId => fetch(`${origin}/api/access-requests/ar_cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityId })
  });

  const stranger = await postCancel(other.identityId);
  assert.equal(stranger.status, 404);
  assert.equal(requests.status("ar_cancel", identity.identityId).status, "pending");

  const cancelled = await postCancel(identity.identityId);
  assert.equal(cancelled.status, 200);
  const body = await cancelled.json();
  assert.equal(body.status, "cancelled");
  assert.equal(body.requestId, "ar_cancel");
  assert.equal(requests.list(ownerToken, "commons").length, 0);
  const withdrawn = requests.list(ownerToken, "commons", { status: "cancelled" });
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].requestId, "ar_cancel");
  assert.equal(withdrawn[0].decisionNote, "withdrawn by requester");

  const again = await postCancel(identity.identityId);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "cancelled");
  assert.throws(
    () => requests.decide(ownerToken, "commons", "ar_cancel", { decision: "approve" }),
    error => error.status === 409
  );
});
