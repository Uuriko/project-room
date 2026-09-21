import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const token = () => randomBytes(32).toString("base64url");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitation-owner-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const identity = store.identities.create("Owning Agent");
  const created = rooms.create(identity.secret, {
    roomId: "agent-den", title: "Agent Den", purpose: "Owner invitation administration",
    kind: "personal", displayName: "Den Keeper"
  });
  store.createAccount("account-target");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, identity, ownerMemberId: created.ownerMemberId };
}

const issueDetails = (overrides = {}) => ({
  requestId: overrides.requestId ?? randomUUID(),
  token: token(),
  intendedAccountId: "account-target",
  intendedMemberId: overrides.intendedMemberId ?? `human-${randomBytes(4).toString("hex")}`,
  displayName: "Invited Human",
  role: "member",
  expiresAt: Date.now() + 3600000,
  expectedIssuerMemberRevision: overrides.expectedIssuerMemberRevision ?? 0,
  expectedSessionBinding: null
});

test("agent owner issues an invitation on its identity bearer", t => {
  const f = fixture(t);
  const result = f.store.issueInvitation(f.identity.secret, "agent-den", {
    ...issueDetails(), expectedIssuerMemberRevision: 0
  });
  assert.equal(result.duplicate, false);
  const row = f.store.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(result.invitation.id);
  assert.equal(row.issuer_account_id, null);
  assert.equal(row.issuer_account_auth_epoch, null);
  assert.equal(row.issuer_member_id, f.ownerMemberId);
  f.store.verifyInvitationAudit();
});

test("agent-owner issuance is idempotent on the member-scoped request id", t => {
  const f = fixture(t);
  const details = { ...issueDetails(), expectedIssuerMemberRevision: 0 };
  const first = f.store.issueInvitation(f.identity.secret, "agent-den", details);
  const second = f.store.issueInvitation(f.identity.secret, "agent-den", details);
  assert.equal(second.duplicate, true);
  assert.equal(second.invitation.id, first.invitation.id);
});

test("agent owner reads invitation stats on its identity bearer", t => {
  const f = fixture(t);
  f.store.issueInvitation(f.identity.secret, "agent-den", { ...issueDetails(), expectedIssuerMemberRevision: 0 });
  const stats = f.store.invitationStats(f.identity.secret, "agent-den", null);
  assert.equal(stats.roomId, "agent-den");
  assert.equal(stats.pending, 1);
});

test("agent owner revokes on its identity bearer; the journal stays honest", t => {
  const f = fixture(t);
  const issued = f.store.issueInvitation(f.identity.secret, "agent-den", { ...issueDetails(), expectedIssuerMemberRevision: 0 });
  const revoked = f.store.revokeInvitation(f.identity.secret, issued.invitation.id, {
    expectedRevision: 0, reason: "no longer needed", expectedSessionBinding: null, expectedRoomId: "agent-den"
  });
  assert.equal(revoked.invitation.status, "revoked");
  const row = f.store.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(issued.invitation.id);
  assert.equal(row.revoked_by_account_id, null);
  assert.equal(row.revoked_by_member_id, f.ownerMemberId);
  assert.equal(row.revoke_reason, "no longer needed");
  f.store.verifyInvitationAudit();
});

test("a non-owner agent member cannot administer invitations", t => {
  const f = fixture(t);
  const other = f.store.identities.create("Other Agent");
  // Join the room as an ordinary member first: the denial must be the
  // admin gate (403 account_session_required), not missing membership.
  f.store.identities.link(f.identity.secret, "agent-den", {
    identityId: other.identityId, displayName: "Other Agent", permissions: ["accept_work"]
  });
  assert.throws(() => f.store.issueInvitation(other.secret, "agent-den", issueDetails()),
    /account browser session/);
  assert.throws(() => f.store.invitationStats(other.secret, "agent-den", null),
    /account browser session/);
});

test("revoking another room's invitation fails closed", t => {
  const f = fixture(t);
  const otherIdentity = f.store.identities.create("Second Owner");
  const rooms = new AgentRooms(f.store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  rooms.create(otherIdentity.secret, {
    roomId: "agent-den-2", title: "Second Den", purpose: "wrong-room check",
    kind: "personal", displayName: "Keeper 2"
  });
  const issued = f.store.issueInvitation(f.identity.secret, "agent-den", { ...issueDetails(), expectedIssuerMemberRevision: 0 });
  assert.throws(() => f.store.revokeInvitation(otherIdentity.secret, issued.invitation.id, {
    expectedRevision: 0, reason: "wrong room", expectedSessionBinding: null, expectedRoomId: "agent-den-2"
  }), /not found in this Room/);
});

test("ownership transfer invalidates the prior owner's agent-issued invitation", t => {
  const f = fixture(t);
  const details = { ...issueDetails(), expectedIssuerMemberRevision: 0 };
  f.store.issueInvitation(f.identity.secret, "agent-den", details);
  // Transfer ownership to a human member: the old owner's invitation goes stale.
  const ownerKey = f.store.issueAccessKey("agent-den", f.ownerMemberId);
  f.store.command(ownerKey, "agent-den", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "human-successor", displayName: "Successor", kind: "human", permissions: ["accept_work"] }
  });
  f.store.command(ownerKey, "agent-den", {
    id: randomUUID(), type: T.OWNERSHIP_TRANSFERRED,
    data: { toMemberId: "human-successor", reason: "test" }
  });
  assert.equal(f.store.previewInvitation(details.token).status, "stale");
});

test("a revised owner member invalidates its agent-issued invitation", t => {
  const f = fixture(t);
  const details = { ...issueDetails(), expectedIssuerMemberRevision: 0 };
  f.store.issueInvitation(f.identity.secret, "agent-den", details);
  // Bump the owner member revision; the invitation goes stale.
  const ownerKey = f.store.issueAccessKey("agent-den", f.ownerMemberId);
  f.store.command(ownerKey, "agent-den", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: f.ownerMemberId, expectedMemberRevision: 0, permissions: ["accept_work", "manage_members"], active: true }
  });
  assert.equal(f.store.previewInvitation(details.token).status, "stale");
});
