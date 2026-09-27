import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { roomUsageSummary } from "../server/usage-summary.mjs";

const roomId = "commons";
function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const owner = store.issueAccessKey(roomId, "owner");
  const send = (type, data) => store.command(owner, roomId, { id: randomUUID(), type, data });
  // Exactly 100 records with 99 active members: an inactive member stays in history.
  for (let i = 1; i < PILOT_LIMITS.membersPerRoom; i++) {
    send(T.MEMBER_ADDED, { memberId: `member-${i}`, displayName: `Member ${i}`, kind: "human", permissions: [] });
  }
  send(T.MEMBER_ACCESS_CHANGED, { memberId: "member-1", expectedMemberRevision: 0, permissions: [], active: false });
  assert.equal(Object.keys(store.room(roomId).state.members).length, 100);
  assert.equal(roomUsageSummary(store, owner, roomId).caps.members.used, 99);
  return { store, owner, send };
}

const full = (store, owner) => {
  const cap = roomUsageSummary(store, owner, roomId).caps.members;
  assert.deepEqual(cap, { used: 100, limit: 100, remaining: 0 });
  assert.equal(store.room(roomId).state.members["member-1"].active, false);
};

test("inactive history does not consume the 100-active-member command cap", t => {
  const { store, owner, send } = fixture(t);
  send(T.MEMBER_ADDED, { memberId: "member-100", displayName: "Member 100", kind: "human", permissions: [] });
  full(store, owner);
  assert.throws(() => send(T.MEMBER_ADDED, { memberId: "member-101", displayName: "Member 101", kind: "human", permissions: [] }), { code: "pilot_limit", status: 409 });
});

test("invitation acceptance counts active seats and refuses the next admission", t => {
  const { store, owner } = fixture(t);
  const accountId = "account-invited";
  store.createAccount(accountId);
  const key = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const target = store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
  const ownerAccount = store.accountForMember(roomId, "owner");
  const ownerKey = store.issueAccountAccessKey(ownerAccount.id);
  const ownerSlot = store.createAccountSessionSlot();
  const ownerSession = store.loginAccountSession(ownerSlot.token, ownerKey, 0);
  const invitationToken = randomBytes(32).toString("base64url");
  const offer = name => store.issueInvitation(ownerSlot.token, roomId, {
    requestId: randomUUID(), token: invitationToken, intendedAccountId: accountId,
    intendedMemberId: name, displayName: name, role: "member", expiresAt: store.now() + 3600000,
    expectedIssuerMemberRevision: store.room(roomId).state.members.owner.revision,
    expectedSessionBinding: ownerSession.sessionBinding
  });
  const first = offer("new-member");
  const redemptionId = randomUUID();
  const accepted = store.acceptInvitation(slot.token, invitationToken, {
    redemptionId, expectedRevision: 0, expectedSessionBinding: target.sessionBinding
  });
  assert.equal(accepted.session.member.id, "new-member");
  full(store, owner);
  assert.equal(Object.keys(store.room(roomId).state.members).length, 101);
  const retry = store.acceptInvitation(slot.token, invitationToken, { redemptionId, expectedRevision: 0, expectedSessionBinding: target.sessionBinding });
  assert.equal(retry.duplicate, true);
});

test("agent invite and share-link entrances count active seats", t => {
  const { store, owner } = fixture(t);
  const invitation = store.invites.create(owner, roomId, { permissions: ["accept_work"], displayName: "New agent" });
  const joined = store.invites.redeem(invitation.code, { displayName: "New agent" });
  assert.ok(joined.identityId);
  full(store, owner);
  const secondInvite = store.invites.create(owner, roomId, { permissions: ["accept_work"], displayName: "Blocked agent" });
  assert.throws(() => store.invites.redeem(secondInvite.code, { displayName: "Blocked agent" }), { code: "pilot_limit", status: 409 });
  const linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(owner, roomId, { requestId: randomUUID(), linkToken, expiresAt: store.now() + 3600000,
    maxJoins: 1, expectedMemberRevision: store.room(roomId).state.members.owner.revision }, null);
  const other = store.identities.create("Other agent");
  assert.throws(() => store.shareLinks.joinAgent(other.secret, linkToken, "Other agent"), { code: "pilot_limit", status: 409 });
});

test("a human share-link join uses the inactive seat but not the 101st active seat", t => {
  const { store, owner } = fixture(t);
  const linkToken = randomBytes(32).toString("base64url");
  store.shareLinks.create(owner, roomId, { requestId: randomUUID(), linkToken, expiresAt: store.now() + 3600000,
    maxJoins: 2, expectedMemberRevision: store.room(roomId).state.members.owner.revision }, null);
  const slot = store.createAccountSessionSlot();
  const current = store.accountSessionSlot(slot.token);
  const first = store.shareLinks.join(slot.token, linkToken, { displayName: "New human", redemptionId: randomUUID(),
    expectedSessionRevision: current.sessionRevision, expectedSessionBinding: current.sessionBinding });
  assert.equal(first.session.member.displayName, "New human");
  full(store, owner);
  const otherSlot = store.createAccountSessionSlot();
  const other = store.accountSessionSlot(otherSlot.token);
  assert.throws(() => store.shareLinks.join(otherSlot.token, linkToken, { displayName: "Blocked human", redemptionId: randomUUID(),
    expectedSessionRevision: other.sessionRevision, expectedSessionBinding: other.sessionBinding }), { code: "pilot_limit", status: 409 });
});
