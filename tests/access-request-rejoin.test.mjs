import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests } from "../server/access-requests.mjs";

// UT27 15-2 (lane 15-errors F2, executed in prod): a removed member's
// documented recovery — POST /api/access-requests — returned
// 409 stale_membership with a workContext "rebase" hint no revision could
// satisfy, while a never-member's identical request pended idempotently.
// These tests fail on the pre-fix code (the filing itself throws
// stale_membership) and pin the rejoin path: filing is join-kind, approval
// reactivates the SAME member record with the owner's grant, denial leaves
// the member inactive, and a standing auto-approve rule never readmits.
function setup(t, permissions = ["steer"]) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-rejoin-"));
  const filename = join(directory, "room.sqlite");
  const now = Date.now();
  let store = new RoomStore(filename, { now: () => now });
  let requests = new AccessRequests(store);
  store.initialize(initialRoom("commons"));
  const ownerToken = store.issueAccessKey("commons", "owner", 30 * 86400000);
  const identity = store.identities.create("Existing Agent");
  const { memberId } = store.identities.link(ownerToken, "commons", {
    identityId: identity.identityId, memberId: "existing-agent",
    displayName: "Existing Agent", permissions,
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const fixture = {
    get store() { return store; }, ownerToken, identity, memberId,
    get requests() { return requests; },
    member: () => store.roomAuthority("commons").members[memberId],
    request: (requestId = "ar_rejoin", extra = {}) => fixture.requests.request("commons", {
      identityId: identity.identityId, displayName: "Existing Agent",
      requestedPermissions: ["accept_work", "complete_work"], requestId, ...extra,
    }, identity.secret),
    change: (permissions, active = true) => store.command(ownerToken, "commons", {
      id: randomUUID(), type: "member.access_changed",
      data: { memberId, expectedMemberRevision: fixture.member().revision, permissions, active },
    }),
    deactivate: () => fixture.change(["steer"], false),
    reopen: () => { store.close(); store = new RoomStore(filename, { now: () => now }); requests = new AccessRequests(store); },
  };
  return fixture;
}

test("a removed member files a followable join-kind rejoin request", t => {
  const f = setup(t);
  f.deactivate();
  const before = f.member();
  assert.equal(before.active, false);
  // A caller-supplied rename attempt must not rename the member record.
  const filed = f.request("ar_rejoin", { displayName: "Owner" });
  assert.equal(filed.status, "pending");
  assert.equal(filed.kind, "join");
  assert.equal(filed.identityId, f.identity.identityId);
  assert.equal(filed.displayName, "Existing Agent");
  assert.deepEqual(filed.requestedPermissions, ["accept_work", "complete_work"]);
  assert.equal(filed.next[0].action, "poll-status", "the pending response carries the poll-status guidance");
  assert.deepEqual(f.member(), before, "filing must not change the inactive membership");
  // Idempotent replay: the same requestId returns the same pending row and
  // files nothing twice — the never-member control behaviour, verbatim.
  const replay = f.request("ar_rejoin");
  assert.equal(replay.requestId, filed.requestId);
  assert.equal(replay.status, "pending");
  assert.equal(f.requests.list(f.ownerToken, "commons").length, 1);
  // The requester can poll and withdraw it like any join request.
  assert.equal(f.requests.status("ar_rejoin", f.identity.identityId, f.identity.secret).status, "pending");
  assert.equal(f.requests.cancel("ar_rejoin", f.identity.identityId, f.identity.secret).status, "cancelled");
  assert.equal(f.member().active, false);
});

test("owner approval reactivates the same member with the owner's grant", t => {
  const f = setup(t);
  f.deactivate();
  const deactivated = f.member();
  f.request();
  const approved = f.requests.decide(f.ownerToken, "commons", "ar_rejoin", {
    decision: "approve", permissions: ["accept_work"],
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.memberId, f.memberId, "the same member record rejoins — no second member is created");
  assert.equal(approved.rejoined, true);
  assert.deepEqual(approved.grantedPermissions, ["accept_work"]);
  const member = f.member();
  assert.equal(member.active, true);
  assert.deepEqual(member.permissions, ["accept_work"],
    "the owner's grant replaces the stale permissions; the pre-removal grant does not come back silently");
  assert.equal(member.revision, deactivated.revision + 1);
  assert.equal(member.displayName, "Existing Agent");
  assert.equal(f.store.authenticate(f.identity.secret, "commons").member.id, f.memberId,
    "the rejoined identity authenticates as a member again");
  // Exactly one member record and one link survive the round trip.
  assert.equal(Object.values(f.store.roomAuthority("commons").members)
    .filter(m => m.identityId === f.identity.identityId).length, 1);
  f.reopen();
  assert.equal(f.member().active, true, "rejoin survives reopening");
  assert.deepEqual(f.store.rebuildProjection("commons").state.members[f.memberId].permissions,
    ["accept_work"], "rejoin survives event replay");
});

test("owner approval without explicit permissions grants what was requested", t => {
  const f = setup(t);
  f.deactivate();
  f.request();
  const approved = f.requests.decide(f.ownerToken, "commons", "ar_rejoin", { decision: "approve" });
  assert.deepEqual(approved.grantedPermissions, ["accept_work", "complete_work"]);
  assert.deepEqual(f.member().permissions, ["accept_work", "complete_work"]);
  assert.equal(f.member().active, true);
});

test("denial leaves the removed member inactive and free to ask again", t => {
  const f = setup(t);
  f.deactivate();
  f.request();
  const denied = f.requests.decide(f.ownerToken, "commons", "ar_rejoin", { decision: "deny", note: "Not yet" });
  assert.equal(denied.status, "denied");
  assert.equal(f.member().active, false);
  assert.deepEqual(f.member().permissions, ["steer"]);
  const again = f.request("ar_rejoin_2");
  assert.equal(again.status, "pending");
  assert.equal(again.kind, "join");
});

test("a standing auto-approve rule never readmits a removed member", t => {
  const f = setup(t);
  f.requests.setAutoApprove(f.ownerToken, "commons", { permissions: ["accept_work", "complete_work"] });
  f.deactivate();
  const filed = f.request();
  assert.equal(filed.status, "pending", "rejoin waits for a reviewed owner decision even under a matching rule");
  assert.match(filed.pendingNote, /member of this room before/);
  assert.equal(f.member().active, false);
  assert.equal(f.requests.tryAutoApprove("commons", filed.requestId).approved, false);
  assert.equal(f.member().active, false);
});

test("a removed member cannot approve their own rejoin", t => {
  const f = setup(t);
  f.deactivate();
  f.request();
  assert.throws(() => f.requests.decide(f.identity.secret, "commons", "ar_rejoin", { decision: "approve" }),
    error => error.status === 403 || error.status === 401);
  assert.equal(f.member().active, false);
  assert.equal(f.requests.status("ar_rejoin", f.identity.identityId, f.identity.secret).status, "pending");
});

test("self-leave through the member-deactivate path can also rejoin", t => {
  // The prod repro removed B via the documented self-leave, which keeps the
  // identity link — the same inactive-linked shape owner deactivation makes.
  const f = setup(t);
  const token = f.identity.secret;
  const member = f.member();
  f.store.command(token, "commons", {
    id: randomUUID(), type: "member.access_changed",
    data: { memberId: f.memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false },
  });
  assert.equal(f.member().active, false);
  const filed = f.request("ar_self_rejoin");
  assert.equal(filed.kind, "join");
  const approved = f.requests.decide(f.ownerToken, "commons", "ar_self_rejoin", { decision: "approve" });
  assert.equal(approved.rejoined, true);
  assert.equal(f.member().active, true);
});

test("never-member control still files an ordinary join in the same room", t => {
  const f = setup(t);
  f.deactivate();
  const other = f.store.identities.create("Never Member");
  const filed = f.requests.request("commons", {
    identityId: other.identityId, displayName: "Never Member",
    requestedPermissions: ["accept_work"], requestId: "ar_never",
  }, other.secret);
  assert.equal(filed.status, "pending");
  assert.equal(filed.kind, "join");
  const approved = f.requests.decide(f.ownerToken, "commons", "ar_never", { decision: "approve" });
  assert.equal(approved.status, "approved");
  assert.notEqual(approved.memberId, f.memberId);
  assert.equal(f.member().active, false, "approving the control must not revive the removed member");
});
