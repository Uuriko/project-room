// Issue #2912: a fresh access request was filed for any identityId with no
// proof of the identity secret. Anyone who learned an identityId could
// file requests in that identity's name (caller-chosen display name and
// permissions), spend its rate-limit bucket and its pending-request cap,
// and — in a room with an auto-approve rule — be admitted as that
// identity inline. Filing a fresh join now requires the identity's
// current secret, checked before the rate limiter so bad proofs never
// spend the real holder's quota.
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

function setup(t, rateLimiter = null) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-proof-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: rateLimiter ?? createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  const stranger = store.identities.create("Stranger Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, ownerToken, identity, stranger };
}

const filing = (identity, extra = {}) => ({
  identityId: identity.identityId,
  displayName: "Requesting Agent",
  requestedPermissions: ["accept_work"],
  requestId: "ar_proof",
  ...extra,
});

const rowsFor = (store, requestId) =>
  store.db.prepare("SELECT count(*) AS n FROM access_requests WHERE request_id=?").get(requestId).n;

test("fresh join without the identity secret is refused and files nothing", t => {
  const { store, requests, identity } = setup(t);
  assert.throws(() => requests.request("commons", filing(identity)),
    error => error.status === 401 && error.code === "unauthenticated");
  assert.equal(rowsFor(store, "ar_proof"), 0, "no request row is inserted");
  const events = store.db.prepare(
    "SELECT count(*) AS n FROM events WHERE room_id='commons' AND json_extract(body, '$.type')='access.requested'").get().n;
  assert.equal(events, 0, "no access.requested event is emitted");
});

test("fresh join with another identity's secret is refused", t => {
  const { store, requests, identity, stranger } = setup(t);
  assert.throws(() => requests.request("commons", filing(identity), stranger.secret),
    error => error.status === 401 && error.code === "unauthenticated");
  assert.throws(() => requests.request("commons", filing(identity), "pri_not_a_real_secret"),
    error => error.status === 401);
  assert.equal(rowsFor(store, "ar_proof"), 0);
});

test("fresh join with a revoked secret is refused", t => {
  const { store, requests, identity } = setup(t);
  store.identities.revoke(identity.identityId, identity.secret);
  assert.throws(() => requests.request("commons", filing(identity), identity.secret),
    error => error.status === 401);
  assert.equal(rowsFor(store, "ar_proof"), 0);
});

test("fresh join with the identity's own secret files the request", t => {
  const { requests, identity } = setup(t);
  const filed = requests.request("commons", filing(identity), identity.secret);
  assert.equal(filed.status, "pending");
  assert.equal(filed.identityId, identity.identityId);
  assert.deepEqual(filed.requestedPermissions, ["accept_work"]);
});

test("bad proofs do not spend the holder's rate-limit bucket", t => {
  // Capacity 1: if a bad proof consumed the bucket, the holder's own
  // filing right after would be rate-limited instead of filed.
  const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1 / 3600 });
  const { requests, identity, stranger } = setup(t, limiter);
  for (let i = 0; i < 3; i++) {
    assert.throws(() => requests.request("commons",
      filing(identity, { requestId: `ar_bad_${i}` }), stranger.secret),
      error => error.status === 401);
    assert.throws(() => requests.request("commons",
      filing(identity, { requestId: `ar_none_${i}` })),
      error => error.status === 401);
  }
  const filed = requests.request("commons", filing(identity), identity.secret);
  assert.equal(filed.status, "pending");
});

test("auto-approve cannot admit an identity whose secret was not proven", t => {
  const { store, requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  assert.throws(() => requests.request("commons", filing(identity)),
    error => error.status === 401);
  // No membership, no link, no request row for the unproven filing.
  assert.equal(store.room("commons").state.members[identity.identityId], undefined);
  assert.equal(store.db.prepare(
    "SELECT count(*) AS n FROM identity_links WHERE room_id='commons' AND identity_id=?")
    .get(identity.identityId).n, 0);
  assert.equal(rowsFor(store, "ar_proof"), 0);
  // The holder is admitted inline as before.
  const approved = requests.request("commons", filing(identity), identity.secret);
  assert.equal(approved.status, "approved");
  assert.equal(approved.memberId, identity.identityId);
});

test("unknown identity still reads as a bare 404, with or without a secret", t => {
  const { requests, identity, stranger } = setup(t);
  assert.throws(() => requests.request("commons", {
    identityId: "ai_nope", displayName: "Ghost",
    requestedPermissions: ["accept_work"], requestId: "ar_ghost",
  }, stranger.secret), error => error.status === 404);
  // A bad room looks the same, even for a real identity that has not
  // proven its secret: existence is answered before proof is consulted,
  // so the route is not an oracle for which rooms exist.
  assert.throws(() => requests.request("no-such-room", {
    identityId: identity.identityId, displayName: "Ghost",
    requestedPermissions: ["accept_work"], requestId: "ar_ghost_room",
  }), error => error.status === 404);
});

test("HTTP: POST /api/access-requests requires the identity secret as Bearer", async t => {
  const { store, identity, stranger } = setup(t);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = secret => fetch(`${origin}/api/access-requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({
      roomId: "commons", identityId: identity.identityId,
      displayName: "Requesting Agent", requestedPermissions: ["accept_work"],
      requestId: "ar_proof_http",
    }),
  });
  assert.equal((await post(null)).status, 401, "no bearer is refused");
  assert.equal((await post(stranger.secret)).status, 401, "another identity's secret is refused");
  assert.equal(rowsFor(store, "ar_proof_http"), 0, "refused filings insert nothing");
  const filed = await post(identity.secret);
  assert.equal(filed.status, 201, "the holder's secret files the request");
  assert.equal((await filed.json()).status, "pending");
});
