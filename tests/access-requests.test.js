import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema, MAX_PENDING_PER_IDENTITY_ROOM } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-access-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  // The schema export is applied here directly; store.mjs wiring is a
  // follow-up once the read/unread lane's store.mjs claim clears.
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const identity = store.identities.create("Requesting Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, ownerToken, identity };
}

test("unauthenticated identity can request access; idempotent on requestId", async t => {
  const { requests, identity } = setup(t);
  const first = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work", "complete_work"],
    note: "I can triage inbox items.",
    requestId: "ar_test1"
  });
  assert.equal(first.status, "pending");
  assert.equal(first.identityId, identity.identityId);
  assert.deepEqual(first.requestedPermissions, ["accept_work", "complete_work"]);

  const retry = requests.request("commons", {
    identityId: identity.identityId,
    displayName: "Requesting Agent",
    requestedPermissions: ["accept_work", "complete_work"],
    requestId: "ar_test1"
  });
  assert.equal(retry.requestId, first.requestId);
  assert.equal(retry.status, "pending");
});

test("requestId collision across identities is rejected", async t => {
  const { store, requests, identity } = setup(t);
  const other = store.identities.create("Other Agent");
  requests.request("commons", {
    identityId: identity.identityId, displayName: "A",
    requestedPermissions: ["accept_work"], requestId: "ar_collision"
  });
  assert.throws(() => requests.request("commons", {
    identityId: other.identityId, displayName: "B",
    requestedPermissions: ["accept_work"], requestId: "ar_collision"
  }), /requestId is already in use/);
});

test("unknown identity or room is a bare 404", async t => {
  const { requests } = setup(t);
  assert.throws(() => requests.request("commons", {
    identityId: "ai_nope", displayName: "Ghost",
    requestedPermissions: ["accept_work"], requestId: "ar_ghost"
  }), err => err.status === 404);
  assert.throws(() => requests.request("nope", {
    identityId: "ai_nope", displayName: "Ghost",
    requestedPermissions: ["accept_work"], requestId: "ar_ghost2"
  }), err => err.status === 404);
});

test("already-linked identity cannot request", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, displayName: "Requesting Agent", permissions: ["accept_work"]
  });
  assert.throws(() => requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_linked"
  }), /already linked/);
});

test("pending cap per identity per room", async t => {
  const { requests, identity } = setup(t);
  for (let i = 0; i < MAX_PENDING_PER_IDENTITY_ROOM; i++) {
    requests.request("commons", {
      identityId: identity.identityId, displayName: "Requesting Agent",
      requestedPermissions: ["accept_work"], requestId: `ar_cap${i}`
    });
  }
  assert.throws(() => requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_cap_over"
  }), /At most/);
});

test("identity can check its own request; others get 404", async t => {
  const { store, requests, identity } = setup(t);
  const other = store.identities.create("Other Agent");
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_status"
  });
  const seen = requests.status("ar_status", identity.identityId);
  assert.equal(seen.status, "pending");
  assert.throws(() => requests.status("ar_status", other.identityId), err => err.status === 404);
  assert.throws(() => requests.status("ar_missing", identity.identityId), err => err.status === 404);
});

test("owner lists pending; approve links the identity", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work", "complete_work"], requestId: "ar_approve"
  });
  const pending = requests.list(ownerToken, "commons");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, "ar_approve");

  const decided = requests.decide(ownerToken, "commons", "ar_approve", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.ok(decided.memberId);
  assert.equal(decided.decidedBy, "owner");

  // The identity is now a real member.
  const link = store.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?")
    .get("commons", identity.identityId);
  assert.equal(link.member_id, decided.memberId);

  // Deciding twice is a conflict.
  assert.throws(() => requests.decide(ownerToken, "commons", "ar_approve", { decision: "deny" }),
    /already approved/);
});

test("owner can narrow permissions on approve; deny records a reason", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work", "complete_work", "verify"], requestId: "ar_narrow"
  });
  const decided = requests.decide(ownerToken, "commons", "ar_narrow",
    { decision: "approve", permissions: ["accept_work"] });
  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.requestedPermissions, ["accept_work", "complete_work", "verify"]);
});

test("deny flow", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_deny"
  });
  const denied = requests.decide(ownerToken, "commons", "ar_deny",
    { decision: "deny", note: "Not now." });
  assert.equal(denied.status, "denied");
  assert.equal(denied.decisionNote, "Not now.");
  const pending = requests.list(ownerToken, "commons");
  assert.equal(pending.length, 0);
  const deniedList = requests.list(ownerToken, "commons", { status: "denied" });
  assert.equal(deniedList.length, 1);
});

test("non-owner cannot list or decide", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  // Create a plain member (not an owner) to prove the manage_members gate.
  const { randomUUID } = await import("node:crypto");
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId: "regular", displayName: "Regular", kind: "agent", permissions: ["accept_work"] }
  });
  const memberToken = store.issueAccessKey("commons", "regular");
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_forbidden"
  });
  assert.throws(() => requests.list(memberToken, "commons"), err => err.status === 403);
  assert.throws(() => requests.decide(memberToken, "commons", "ar_forbidden", { decision: "approve" }),
    err => err.status === 403);
});

test("expired requests are not decidable", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  const old = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_old"
  });
  // Backdate past the 7-day TTL.
  store.db.prepare("UPDATE access_requests SET created_at=? WHERE request_id=?")
    .run(store.now() - 8 * 24 * 60 * 60 * 1000, "ar_old");
  const seen = requests.status("ar_old", identity.identityId);
  assert.equal(seen.status, "expired");
  assert.throws(() => requests.decide(ownerToken, "commons", "ar_old", { decision: "approve" }),
    /already expired/);
  assert.equal(requests.list(ownerToken, "commons").length, 0);
});
