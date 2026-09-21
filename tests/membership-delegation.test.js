import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { membershipDelegationSchema } from "../server/membership-delegation.mjs";

// RC-2026-09-18-038: owner-granted membership administration for agent
// identities. The room owner grants an agent identity the right to list and
// decide access requests; the grant is revocable, owner-only, and never
// self-grantable.
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-delegation-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  store.db.exec(membershipDelegationSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const delegation = store.delegation;
  const ownerToken = store.issueAccessKey("commons", "owner");
  // The would-be delegate: a linked agent identity with work permissions only.
  const agent = store.identities.create("Delegate Agent");
  store.identities.link(ownerToken, "commons", {
    identityId: agent.identityId, displayName: "Delegate Agent",
    permissions: ["accept_work", "complete_work", "steer", "verify"]
  });
  // A second agent, never granted: the control group.
  const other = store.identities.create("Other Agent");
  store.identities.link(ownerToken, "commons", {
    identityId: other.identityId, displayName: "Other Agent",
    permissions: ["accept_work", "complete_work"]
  });
  // A requester whose request the delegate will decide.
  const requester = store.identities.create("Requesting Agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, requests, delegation, ownerToken, agent, other, requester };
}

function requestAccess(requests, requester, requestId) {
  return requests.request("commons", {
    identityId: requester.identityId, displayName: "Requesting Agent",
    requestedPermissions: ["accept_work"], requestId
  });
}

test("owner can grant membership administration to a linked agent identity", t => {
  const { delegation, ownerToken, agent } = setup(t);
  const grant = delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  assert.equal(grant.roomId, "commons");
  assert.equal(grant.identityId, agent.identityId);
  assert.equal(grant.grantedBy, "owner");
  assert.ok(delegation.hasGrant("commons", agent.identityId));
});

test("granted agent can approve an access request", t => {
  const { requests, delegation, ownerToken, agent, requester } = setup(t);
  requestAccess(requests, requester, "ar_delegate_approve");
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  const decided = requests.decide(agent.secret, "commons", "ar_delegate_approve", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, agent.identityId);
  assert.deepEqual(decided.grantedPermissions, ["accept_work"]);
  // The requester is now a room member through the delegate's approval.
  const authority = requests.store.roomAuthority("commons");
  assert.ok(authority.members[decided.memberId], "approved identity is linked as a member");
});

test("granted agent can deny an access request", t => {
  const { requests, delegation, ownerToken, agent, requester } = setup(t);
  requestAccess(requests, requester, "ar_delegate_deny");
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  const decided = requests.decide(agent.secret, "commons", "ar_delegate_deny", { decision: "deny", note: "not yet" });
  assert.equal(decided.status, "denied");
  assert.equal(decided.decisionNote, "not yet");
});

test("granted agent can list access requests", t => {
  const { requests, delegation, ownerToken, agent, requester } = setup(t);
  requestAccess(requests, requester, "ar_delegate_list");
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  const listed = requests.list(agent.secret, "commons", {});
  assert.ok(listed.some(r => r.requestId === "ar_delegate_list"));
});

test("non-granted agent is still 403 on decide and list (unchanged behavior)", t => {
  const { requests, other, requester } = setup(t);
  requestAccess(requests, requester, "ar_control");
  assert.throws(() => requests.decide(other.secret, "commons", "ar_control", { decision: "approve" }),
    err => err.status === 403 && /Membership administration grant required/.test(err.message));
  assert.throws(() => requests.list(other.secret, "commons", {}),
    err => err.status === 403 && /Membership administration grant required/.test(err.message));
});

test("revoked agent is denied exactly as before the grant", t => {
  const { requests, delegation, ownerToken, agent, requester } = setup(t);
  requestAccess(requests, requester, "ar_revoked");
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  assert.ok(delegation.hasGrant("commons", agent.identityId));
  const revoked = delegation.revoke(ownerToken, "commons", { identityId: agent.identityId });
  assert.equal(revoked.revoked, true);
  assert.equal(delegation.hasGrant("commons", agent.identityId), false);
  assert.throws(() => requests.decide(agent.secret, "commons", "ar_revoked", { decision: "approve" }),
    err => err.status === 403);
});

test("a grant holder cannot grant to anyone else — no self-grant, no transitive grant", t => {
  const { delegation, ownerToken, agent, other } = setup(t);
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  // The delegate tries to grant itself a fresh grant (already holds one).
  assert.throws(() => delegation.grant(agent.secret, "commons", { identityId: agent.identityId }),
    err => err.status === 403 && /Only the room owner/.test(err.message));
  // The delegate tries to grant a different identity.
  assert.throws(() => delegation.grant(agent.secret, "commons", { identityId: other.identityId }),
    err => err.status === 403 && /Only the room owner/.test(err.message));
});

test("a non-owner human holding manage_members cannot grant either", t => {
  const { delegation, ownerToken } = setup(t);
  // Create a human member with manage_members via an access key.
  const humanKey = "rk_test_human_member_key_001";
  const store = delegation.store;
  store.command(ownerToken, "commons", { id: "evt-human-add", type: "member.added",
    data: { memberId: "human2", displayName: "Human Two", kind: "human", permissions: ["manage_members", "steer"] } });
  const humanToken = store.issueAccessKey("commons", "human2");
  assert.throws(() => delegation.grant(humanToken, "commons", { identityId: "ai_anything" }),
    err => err.status === 403 && /Only the room owner/.test(err.message));
  void humanKey;
});

test("grant requires a linked agent identity in this room", t => {
  const { delegation, ownerToken, requester } = setup(t);
  // requester has an identity but is NOT linked into the room.
  assert.throws(() => delegation.grant(ownerToken, "commons", { identityId: requester.identityId }),
    err => err.status === 404);
  assert.throws(() => delegation.grant(ownerToken, "commons", { identityId: "ai_nope" }),
    err => err.status === 404);
});

test("double grant is a 409; revoked grant can be re-granted", t => {
  const { delegation, ownerToken, agent } = setup(t);
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  assert.throws(() => delegation.grant(ownerToken, "commons", { identityId: agent.identityId }),
    err => err.status === 409);
  delegation.revoke(ownerToken, "commons", { identityId: agent.identityId });
  const again = delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  assert.equal(again.identityId, agent.identityId);
  assert.ok(delegation.hasGrant("commons", agent.identityId));
});

test("owner still decides and lists exactly as before", t => {
  const { requests, ownerToken, requester } = setup(t);
  requestAccess(requests, requester, "ar_owner");
  const listed = requests.list(ownerToken, "commons", {});
  assert.ok(listed.some(r => r.requestId === "ar_owner"));
  const decided = requests.decide(ownerToken, "commons", "ar_owner", { decision: "approve" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, "owner");
});

test("grant does not put manage_members in the agent's member permissions", t => {
  const { delegation, ownerToken, agent } = setup(t);
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  const authority = delegation.store.roomAuthority("commons");
  const member = authority.members[agent.identityId];
  assert.ok(member, "delegate is a room member");
  assert.equal(member.permissions.includes("manage_members"), false,
    "the delegation must not leak manage_members into member permissions");
});

test("grant adds agent-safe invite_member; revoke strips it again", t => {
  const { delegation, ownerToken, agent } = setup(t);
  const before = delegation.store.roomAuthority("commons").members[agent.identityId].permissions;
  assert.equal(before.includes("invite_member"), false);
  delegation.grant(ownerToken, "commons", { identityId: agent.identityId });
  const during = delegation.store.roomAuthority("commons").members[agent.identityId].permissions;
  assert.ok(during.includes("invite_member"), "delegate gains invite_member for the approve() path");
  assert.equal(during.includes("manage_members"), false);
  delegation.revoke(ownerToken, "commons", { identityId: agent.identityId });
  const after = delegation.store.roomAuthority("commons").members[agent.identityId].permissions;
  assert.deepEqual([...after].sort(), [...before].sort(), "revoke restores the prior permission set");
});

test("grant keeps a pre-existing invite_member untouched on revoke", t => {
  const { delegation, ownerToken, agent } = setup(t);
  // Owner links a second identity that already carries invite_member.
  const second = delegation.store.identities.create("Invite Agent");
  delegation.store.identities.link(ownerToken, "commons", {
    identityId: second.identityId, displayName: "Invite Agent",
    permissions: ["accept_work", "invite_member"]
  });
  delegation.grant(ownerToken, "commons", { identityId: second.identityId });
  delegation.revoke(ownerToken, "commons", { identityId: second.identityId });
  const member = delegation.store.roomAuthority("commons").members[second.identityId];
  assert.ok(member.permissions.includes("invite_member"), "pre-existing invite_member survives revoke");
});
