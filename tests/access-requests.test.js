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
  // RC-2026-09-18-036: the response names the actual grant, not just the request.
  assert.deepEqual(decided.grantedPermissions, ["accept_work", "complete_work"]);
  assert.deepEqual(decided.next.map(n => n.action), ["say-hello", "see-new-member"]);
  assert.ok(decided.next[0].path.includes("/api/rooms/commons/commands"));
  assert.ok(decided.next[1].path.includes("/api/rooms/commons/presence"));

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
  // RC-2026-09-18-036: the narrowed grant is named in the response.
  assert.deepEqual(decided.grantedPermissions, ["accept_work"]);
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
  requests.request("commons", {
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

test("unknown permission names fail fast with a self-teaching 422 (RC-2026-09-18-022)", async t => {
  const { requests, ownerToken, identity } = setup(t);
  // The request never pends: ["read","write"] are not room permissions.
  assert.throws(() => requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["read", "write"], requestId: "ar_badnames"
  }), error => {
    assert.equal(error.code, "invalid_request");
    assert.ok(error.message.includes("accept_work"), "422 names real permissions");
    return true;
  });
  // Approval with hand-written bad permissions fails too.
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_goodnames"
  });
  assert.throws(() => requests.decide(ownerToken, "commons", pending.requestId,
    { decision: "approve", permissions: ["read"] }),
    error => {
      assert.equal(error.code, "invalid_request");
      assert.ok(error.message.includes("accept_work"));
      return true;
    });
  // The mirrored vocabulary stays in sync with the canonical PERMISSIONS.
  const { ACCESS_REQUEST_PERMISSIONS } = await import("../server/access-requests.mjs");
  const { PERMISSIONS } = await import("../src/events.js");
  assert.deepEqual([...ACCESS_REQUEST_PERMISSIONS].sort(), [...PERMISSIONS].sort());
});

test("note:null is accepted like an omitted note (RC-2026-09-18-025)", async t => {
  const { requests, identity } = setup(t);
  const created = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], note: null, requestId: "ar_nullnote"
  });
  assert.equal(created.status, "pending");
  assert.equal(created.note, null);
  const seen = requests.status("ar_nullnote", identity.identityId);
  assert.equal(seen.note, null);
  // Non-null notes still validate: non-string and over-long still 422.
  assert.throws(() => requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], note: 123, requestId: "ar_badnote"
  }), err => err.status === 422);
  assert.throws(() => requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], note: "x".repeat(501), requestId: "ar_longnote"
  }), err => err.status === 422);
});

test("decide deny with note:null is accepted like an omitted note (RC-2026-09-18-025)", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_deny_null"
  });
  const denied = requests.decide(ownerToken, "commons", "ar_deny_null",
    { decision: "deny", note: null });
  assert.equal(denied.status, "denied");
  assert.equal(denied.decisionNote, null);
});

// Self-serve admission (RC-2026-09-29-3603): rooms with an auto-approve rule
// admit matching requests inline, with no human in the loop.

test("auto-approve: subset of the configured rule is approved and linked inline", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  const configured = requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", "complete_work"] });
  assert.deepEqual(configured.autoApprove.permissions, ["accept_work", "complete_work"]);
  assert.equal(configured.autoApprove.updatedBy, "owner");

  const approved = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto1"
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.memberId, identity.identityId);
  assert.deepEqual(approved.grantedPermissions, ["accept_work"]);
  assert.equal(approved.next.length, 2);
  // The membership is real: projection, identity link, and event all exist.
  const members = store.room("commons").state.members;
  assert.ok(members[identity.identityId]);
  assert.deepEqual(members[identity.identityId].permissions, ["accept_work"]);
  const link = store.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?")
    .get("commons", identity.identityId);
  assert.equal(link.member_id, identity.identityId);
  const addedEvent = store.db.prepare("SELECT body FROM events WHERE room_id=? AND body LIKE '%\"member.added\"%'")
    .all("commons").map(r => JSON.parse(r.body)).find(e => e.data?.memberId === identity.identityId);
  assert.ok(addedEvent);
  assert.equal(addedEvent.actorId, "owner");
});

test("auto-approve: audit fields on the request row", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", "complete_work"] });
  const approved = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work", "complete_work"], requestId: "ar_auto_audit"
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedBy, "auto-approve");
  assert.ok(typeof approved.decidedAt === "number" && approved.decidedAt > 0);
  assert.match(approved.decisionNote, /auto-approved under standing rule set by owner/);
});

test("auto-approve: superset of the rule stays pending with a reason", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", "complete_work"] });
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work", "steer"], requestId: "ar_auto_super"
  });
  assert.equal(pending.status, "pending");
  assert.match(pending.pendingNote, /outside the rule/);
  assert.equal(pending.memberId, undefined);
});

test("auto-approve: empty request and no rule stay pending without a note", async t => {
  const { requests, identity } = setup(t);
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: [], requestId: "ar_auto_empty"
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.pendingNote, undefined);
});

test("auto-approve: config rejects elevated permissions (manage_members, decide, manage_claims, write_external, invite_member)", async t => {
  const { requests, ownerToken } = setup(t);
  for (const forbidden of ["manage_members", "decide", "manage_claims", "write_external", "invite_member"]) {
    assert.throws(() => requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", forbidden] }),
      err => err.status === 422 && /never grant elevated/.test(err.message),
      `expected 422 for ${forbidden}`);
  }
  // Unknown names and duplicates also 422 with a teaching message.
  assert.throws(() => requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", "fly"] }),
    err => err.status === 422 && /valid:/.test(err.message));
  assert.throws(() => requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work", "accept_work"] }),
    err => err.status === 422 && /must not repeat/.test(err.message));
  // No rule was stored by the rejected writes.
  assert.equal(requests.getAutoApprove(ownerToken, "commons").autoApprove, null);
});

test("auto-approve: non-owner cannot read or write the rule", async t => {
  const { store, requests, ownerToken } = setup(t);
  const { randomUUID } = await import("node:crypto");
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId: "regular", displayName: "Regular", kind: "agent", permissions: ["accept_work"] }
  });
  const memberToken = store.issueAccessKey("commons", "regular");
  assert.throws(() => requests.setAutoApprove(memberToken, "commons", { permissions: ["accept_work"] }),
    err => err.status === 403);
  assert.throws(() => requests.getAutoApprove(memberToken, "commons"), err => err.status === 403);
  // The owner can read back what was set.
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  const read = requests.getAutoApprove(ownerToken, "commons");
  assert.deepEqual(read.autoApprove.permissions, ["accept_work"]);
});

test("auto-approve: empty permission list disables the rule", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  const cleared = requests.setAutoApprove(ownerToken, "commons", { permissions: [] });
  assert.equal(cleared.autoApprove, null);
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_cleared"
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.pendingNote, undefined);
});

test("auto-approve: verified-only rooms never auto-approve the unverified", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  store.agentPlugin.setRoomVerificationPolicy({ roomId: "commons", requireVerified: true, setBy: "owner" });
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_unverified"
  });
  assert.equal(pending.status, "pending");
  assert.match(pending.pendingNote, /verified/);
  // A verified identity in the same room is approved inline.
  store.agentPlugin.verifyIdentity({ identityId: identity.identityId, verifiedBy: "owner" });
  const approved = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_verified"
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedBy, "auto-approve");
});

test("auto-approve: rule suspends when its author loses membership administration", async t => {
  const { store, requests, ownerToken, identity } = setup(t);
  const { randomUUID } = await import("node:crypto");
  // A manager sets the rule, then the owner strips their manage_members.
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId: "manager", displayName: "Manager", kind: "agent", permissions: ["accept_work", "manage_members"] }
  });
  const managerToken = store.issueAccessKey("commons", "manager");
  requests.setAutoApprove(managerToken, "commons", { permissions: ["accept_work"] });
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.access_changed",
    data: { memberId: "manager", expectedMemberRevision: 0, active: true, permissions: ["accept_work"] }
  });
  const pending = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_demoted"
  });
  assert.equal(pending.status, "pending");
  assert.match(pending.pendingNote, /suspended/);
});

test("auto-approve: idempotent retry on an approved request returns the approval", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  const first = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_retry"
  });
  assert.equal(first.status, "approved");
  const retry = requests.request("commons", {
    identityId: identity.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_retry"
  });
  assert.equal(retry.status, "approved");
  assert.equal(retry.decidedBy, "auto-approve");
  assert.equal(retry.memberId, identity.identityId);
  assert.deepEqual(retry.grantedPermissions, ["accept_work"]);
});

test("auto-approve: deceptive display names never auto-admit", async t => {
  const { store, requests, ownerToken } = setup(t);
  const { randomUUID } = await import("node:crypto");
  store.command(ownerToken, "commons", {
    id: randomUUID(), type: "member.added",
    data: { memberId: "alice", displayName: "Alice", kind: "agent", permissions: ["accept_work"] }
  });
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["accept_work"] });
  // Fullwidth "Ａ" (U+FF21) looks identical to "A" but is a different code
  // point: the room-level skeleton check must catch what global identity
  // creation (NFKC-normalized, single-script) legitimately allows.
  const impostor = store.identities.create("Ａlice");
  assert.throws(() => requests.request("commons", {
    identityId: impostor.identityId, displayName: "Ａlice",
    requestedPermissions: ["accept_work"], requestId: "ar_auto_deceptive"
  }), error => error.status === 422 && error.code === "display_name_unavailable" && error.reason === "duplicate");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM access_requests WHERE request_id=?").get("ar_auto_deceptive").n, 0);
  assert.equal(store.room("commons").state.members[impostor.identityId], undefined);
});

test("pending responses carry service-level poll-status guidance", async t => {
  const { requests, identity } = setup(t);
  // Plain pending (no auto-approve rule configured: no pendingNote branch).
  const first = requests.request("commons", {
    identityId: identity.identityId, displayName: "Guided Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_guide_plain"
  });
  assert.equal(first.status, "pending");
  assert.equal(first.next[0].action, "poll-status");
  assert.equal(first.next[0].method, "GET");
  assert.ok(first.next[0].path.includes(`/api/access-requests/${first.requestId}`),
    "poll-status path names the request");
  assert.ok(first.next[0].path.includes(`identityId=${identity.identityId}`),
    "poll-status path carries the identity");
  assert.ok(first.next[0].description.includes("7 days"), "poll-status states the expiry window");
  assert.equal(first.next[1].action, "cancel-request");
  assert.equal(first.next[1].method, "POST");
  assert.ok(first.next[1].path.endsWith(`/api/access-requests/${first.requestId}`));

  // Idempotent retry of a still-pending request carries the same guidance.
  const retry = requests.request("commons", {
    identityId: identity.identityId, displayName: "Guided Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_guide_plain"
  });
  assert.equal(retry.status, "pending");
  assert.deepEqual(retry.next.map(n => n.action), ["poll-status", "cancel-request"]);
});

test("pending guidance fires alongside a pendingNote when a rule is configured but does not match", async t => {
  const { requests, ownerToken, identity } = setup(t);
  requests.setAutoApprove(ownerToken, "commons", { permissions: ["complete_work"] });
  // requestedPermissions (accept_work) are not a subset of the rule
  // (complete_work): the request pends with a pendingNote AND the guidance.
  const filed = requests.request("commons", {
    identityId: identity.identityId, displayName: "Mismatched Agent",
    requestedPermissions: ["accept_work"], requestId: "ar_guide_mismatch"
  });
  assert.equal(filed.status, "pending");
  assert.ok(filed.pendingNote, "pendingNote explains why the rule did not fire");
  assert.equal(filed.next[0].action, "poll-status");
  assert.equal(filed.next[1].action, "cancel-request");
});
