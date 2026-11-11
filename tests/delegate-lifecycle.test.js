// F-1 / F-5 (bug sweep 2026-10-16, lane 08): delegated authority has a
// lifecycle. Owner-delegate and membership-delegation grants lapse when
// the granter's account is deleted and when room ownership transfers;
// a grant-conferred invite_member bit is stripped when its conferring
// grant dies (and only then); guest invites minted by a delegate carry
// issuing-authority provenance so deletion can revoke them and
// redemption fails closed once the authority is gone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { planAccountDeletion, executeAccountDeletion } from "../server/account-deletion.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

function buildWorld(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `delegate-lifecycle-${label}-`));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  store.createAccount("owner-acct");
  store.bindHumanAccount("commons", "owner", "owner-acct");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "partner", displayName: "Partner", kind: "human", permissions: ["accept_work"] });
  store.createAccount("partner-acct");
  store.bindHumanAccount("commons", "partner", "partner-acct");

  // The delegate: linked with ONE permission, so every power it exercises
  // beyond that comes from the two grants.
  const agent = store.identities.create("Delegate Agent");
  const linked = linkWithProof(store, ownerKey, "commons", agent, { displayName: "Delegate Agent", permissions: ["accept_work"] });
  setTier(store.db, "commons", linked.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  store.ownerDelegates.grant(ownerKey, "commons", { identityId: agent.identityId });
  store.delegation.grant(ownerKey, "commons", { identityId: agent.identityId });
  return { store, requests, ownerKey, agent, delegateMemberId: linked.memberId };
}

const grantRows = (store, identityId) => ({
  owner: store.db.prepare("SELECT * FROM owner_delegate_grants WHERE room_id='commons' AND identity_id=?").get(identityId),
  membership: store.db.prepare("SELECT * FROM membership_delegation_grants WHERE room_id='commons' AND identity_id=?").get(identityId)
});

const memberOf = (store, memberId) => store.roomAuthority("commons").members[memberId];

function assertDelegatePowersDead(w) {
  const { store, requests, agent } = w;
  assert.equal(store.ownerDelegates.hasGrant("commons", agent.identityId), false);
  assert.equal(store.delegation.hasGrant("commons", agent.identityId), false);
  const auth = store.authenticate(agent.secret, "commons");
  assert.notEqual(auth.delegate, true);
  assert.notEqual(auth.member.delegatedOwner, true);
  // The scope-bypass mint: refused now that the grant is gone.
  assert.throws(() => store.invites.create(agent.secret, "commons", { permissions: ["write_external"] }));
  // Membership administration: a fresh access request cannot be decided.
  const requester = store.identities.create("Late Requester");
  const req = requests.request("commons", {
    identityId: requester.identityId, displayName: "Late Requester",
    requestedPermissions: ["accept_work"], requestId: `req-${randomUUID().slice(0, 8)}`
  }, requester.secret);
  assert.throws(() => requests.decide(agent.secret, "commons", req.requestId, { decision: "approve" }));
  // The guest-invite owner gate no longer accepts the delegate.
  assert.throws(() => store.guestInvites.ownerGate(agent.secret, "commons", null));
}

function assertBaselinePowers(w) {
  const { store, agent, delegateMemberId } = w;
  const auth = store.authenticate(agent.secret, "commons");
  assert.equal(auth.delegate, true);
  assert.equal(auth.member.delegatedOwner, true);
  assert.ok(memberOf(store, delegateMemberId).permissions.includes("invite_member"));
  const minted = store.invites.create(agent.secret, "commons", { permissions: ["write_external"] });
  assert.ok(minted);
}

test("account deletion lapses both grants, strips the conferred bit, and ends the delegate's powers", t => {
  const w = buildWorld(t, "deletion");
  const { store, agent, delegateMemberId } = w;
  assertBaselinePowers(w);

  const { plan } = planAccountDeletion(store, "owner-acct");
  const step = plan.steps.find(s => s.category === "delegated_authority");
  assert.ok(step, "deletion plan carries a delegated_authority step");
  assert.equal(step.itemCount, 2);

  const receipt = executeAccountDeletion(store, plan);
  assert.equal(receipt.purged.find(p => p.category === "delegated_authority")?.removed, 2);

  const rows = grantRows(store, agent.identityId);
  assert.notEqual(rows.owner.revoked_at, null);
  assert.notEqual(rows.membership.revoked_at, null);
  assert.ok(!memberOf(store, delegateMemberId).permissions.includes("invite_member"),
    "grant-conferred invite_member bit is stripped");
  assertDelegatePowersDead(w);

  // Journals distinguish the lifecycle revocation from a manual one.
  const ownerJournal = store.db.prepare(
    "SELECT action, actor_id FROM owner_delegate_journal WHERE room_id='commons' AND identity_id=? ORDER BY sequence DESC LIMIT 1"
  ).get(agent.identityId);
  assert.deepEqual({ ...ownerJournal }, { action: "revoke", actor_id: "account_deleted" });
  const membershipJournal = store.db.prepare(
    "SELECT action, actor_id FROM membership_delegation_journal WHERE room_id='commons' AND identity_id=? ORDER BY sequence DESC LIMIT 1"
  ).get(agent.identityId);
  assert.deepEqual({ ...membershipJournal }, { action: "revoke", actor_id: "account_deleted" });
  assert.doesNotThrow(() => store.delegationJournal.verify());

  // The inheriting owner's delegate list shows no grant from the deleted granter.
  const heir = store.room("commons").state.room.ownerId;
  const heirKey = store.issueAccessKey("commons", heir);
  assert.equal(store.ownerDelegates.list(heirKey, "commons")
    .some(g => g.identityId === agent.identityId), false);
});

test("a permission bit held from another source survives the grant's death", t => {
  const w = buildWorld(t, "bit-source");
  const { store, ownerKey, delegateMemberId } = w;
  // Second delegate whose member already holds invite_member BEFORE the
  // membership grant: the grant confers nothing (added_invite_member = 0).
  const second = store.identities.create("Second Delegate");
  const linkedSecond = linkWithProof(store, ownerKey, "commons", second, { displayName: "Second Delegate", permissions: ["accept_work"] });
  setTier(store.db, "commons", linkedSecond.memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const secondMember = memberOf(store, linkedSecond.memberId);
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: {
    memberId: secondMember.id, expectedMemberRevision: secondMember.revision,
    permissions: [...secondMember.permissions, "invite_member"], active: secondMember.active
  } });
  store.delegation.grant(ownerKey, "commons", { identityId: second.identityId });
  const secondRow = grantRows(store, second.identityId).membership;
  assert.equal(secondRow.added_invite_member, 0, "grant recorded as conferring nothing");
  const firstRow = grantRows(store, w.agent.identityId).membership;
  assert.equal(firstRow.added_invite_member, 1, "first grant did confer the bit");

  const { plan } = planAccountDeletion(store, "owner-acct");
  executeAccountDeletion(store, plan);

  assert.ok(!memberOf(store, delegateMemberId).permissions.includes("invite_member"),
    "grant-conferred bit stripped");
  assert.ok(memberOf(store, linkedSecond.memberId).permissions.includes("invite_member"),
    "independently held bit stays");
  assert.notEqual(grantRows(store, second.identityId).membership.revoked_at, null,
    "second grant still lapses");
});

test("positive controls: a live delegate keeps its powers; manual revoke and re-grant work", t => {
  const w = buildWorld(t, "controls");
  const { store, ownerKey, agent } = w;
  assertBaselinePowers(w);

  store.ownerDelegates.revoke(ownerKey, "commons", { identityId: agent.identityId });
  store.delegation.revoke(ownerKey, "commons", { identityId: agent.identityId });
  assertDelegatePowersDead(w);

  store.ownerDelegates.grant(ownerKey, "commons", { identityId: agent.identityId });
  store.delegation.grant(ownerKey, "commons", { identityId: agent.identityId });
  assert.equal(store.ownerDelegates.hasGrant("commons", agent.identityId), true);
  assert.equal(store.delegation.hasGrant("commons", agent.identityId), true);
  assert.ok(store.invites.create(agent.secret, "commons", { permissions: ["write_external"] }));
});

test("ownership transfer lapses the outgoing owner's grants; the new owner may re-grant", t => {
  const w = buildWorld(t, "transfer");
  const { store, ownerKey, agent, delegateMemberId } = w;
  assertBaselinePowers(w);

  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.OWNERSHIP_TRANSFERRED, data: { toMemberId: "partner", reason: "lifecycle test" }
  });
  assert.equal(store.room("commons").state.room.ownerId, "partner");
  assert.equal(store.account("owner-acct").active, true, "granter's account survives a pure transfer");

  const rows = grantRows(store, agent.identityId);
  assert.notEqual(rows.owner.revoked_at, null);
  assert.notEqual(rows.membership.revoked_at, null);
  assert.ok(!memberOf(store, delegateMemberId).permissions.includes("invite_member"));
  const ownerJournal = store.db.prepare(
    "SELECT action, actor_id FROM owner_delegate_journal WHERE room_id='commons' AND identity_id=? ORDER BY sequence DESC LIMIT 1"
  ).get(agent.identityId);
  assert.deepEqual({ ...ownerJournal }, { action: "revoke", actor_id: "ownership_transferred" });
  const membershipJournal = store.db.prepare(
    "SELECT action, actor_id FROM membership_delegation_journal WHERE room_id='commons' AND identity_id=? ORDER BY sequence DESC LIMIT 1"
  ).get(agent.identityId);
  assert.deepEqual({ ...membershipJournal }, { action: "revoke", actor_id: "ownership_transferred" });
  assert.doesNotThrow(() => store.delegationJournal.verify());
  assertDelegatePowersDead(w);

  // Nothing inherited: the new owner's list is clean, and a deliberate
  // re-grant restores the delegate's authority.
  const partnerKey = store.issueAccessKey("commons", "partner");
  assert.equal(store.ownerDelegates.list(partnerKey, "commons")
    .some(g => g.identityId === agent.identityId), false);
  store.ownerDelegates.grant(partnerKey, "commons", { identityId: agent.identityId });
  assert.equal(store.ownerDelegates.hasGrant("commons", agent.identityId), true);
  assert.ok(store.invites.create(agent.secret, "commons", { permissions: ["write_external"] }));
});

// ---- F-5: guest-invite authority provenance ----

function guestCard(identity, name) {
  const keys = generateKeyPair();
  const cardBody = { name, description: "visiting agent", capabilities: ["chat"] };
  return { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
}

function mintGuestInvite(store, token, label) {
  const ownerRevision = store.room("commons").state.members.owner.revision;
  return store.guestInvites.mint(token, "commons", {
    requestId: randomUUID(), guestLabel: label, expectedOwnerRevision: ownerRevision
  }, null);
}

test("delegate-minted guest invites trace to the owner's account and are revoked by its deletion", t => {
  const w = buildWorld(t, "guest-deletion");
  const { store, agent } = w;

  const first = mintGuestInvite(store, agent.secret, "first visit");
  const provenance = store.db.prepare("SELECT * FROM guest_invite_authority WHERE invite_id=?").get(first.inviteId);
  assert.equal(provenance.minted_via_delegate, 1);
  assert.equal(provenance.authority_account_id, "owner-acct");
  const inviteRow = store.db.prepare("SELECT minted_by_account_id FROM guest_invites WHERE id=?").get(first.inviteId);
  assert.equal(inviteRow.minted_by_account_id, null, "the invite row itself stays accountless (the F-5 hole)");

  // While the delegation stands, the invite redeems.
  const guest = store.identities.create("Visiting Agent");
  const redeemed = store.guestInvites.redeem(first.code, guest.secret, guestCard(guest, "Visiting Agent"));
  assert.ok(redeemed.token);

  // A second invite, still live when the granter's account is deleted.
  const second = mintGuestInvite(store, agent.secret, "second visit");
  const { plan } = planAccountDeletion(store, "owner-acct");
  executeAccountDeletion(store, plan);
  const secondRow = store.db.prepare("SELECT status FROM guest_invites WHERE id=?").get(second.inviteId);
  assert.equal(secondRow.status, "revoked", "deletion revokes the invite through its authority provenance");
  const lateGuest = store.identities.create("Late Guest");
  assert.throws(
    () => store.guestInvites.redeem(second.code, lateGuest.secret, guestCard(lateGuest, "Late Guest")),
    error => error.code === "invite_unavailable"
  );
});

test("a delegate-minted guest invite fails closed at redeem once the delegation lapses; an owner-minted invite still redeems", t => {
  const w = buildWorld(t, "guest-transfer");
  const { store, ownerKey, agent } = w;

  const delegated = mintGuestInvite(store, agent.secret, "delegate visit");
  const own = mintGuestInvite(store, ownerKey, "owner visit");
  const ownProvenance = store.db.prepare("SELECT * FROM guest_invite_authority WHERE invite_id=?").get(own.inviteId);
  assert.equal(ownProvenance.minted_via_delegate, 0);
  assert.equal(ownProvenance.authority_account_id, "owner-acct");

  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.OWNERSHIP_TRANSFERRED, data: { toMemberId: "partner", reason: "lifecycle test" }
  });

  // The invite row is untouched — the revocation lives in the lapsed
  // grant — but redemption re-checks the authority and fails closed.
  assert.equal(store.db.prepare("SELECT status FROM guest_invites WHERE id=?").get(delegated.inviteId).status, "active");
  const guest = store.identities.create("Blocked Guest");
  assert.throws(
    () => store.guestInvites.redeem(delegated.code, guest.secret, guestCard(guest, "Blocked Guest")),
    error => error.code === "invite_unavailable"
  );
  // The previous owner's own invite stands on their (still live) account.
  const welcome = store.identities.create("Welcome Guest");
  const redeemed = store.guestInvites.redeem(own.code, welcome.secret, guestCard(welcome, "Welcome Guest"));
  assert.ok(redeemed.token);
});
