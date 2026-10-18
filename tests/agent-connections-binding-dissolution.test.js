// Regression: verifyHistory demanded that the sponsor member's CURRENT
// member_accounts binding still name the operation's sponsor account.
// The binding is a current-state record, not an at-the-time fact —
// apply() authenticated the sponsor's account session when the
// operation landed (the operations row's actor_account_id carries that
// account and is still cross-checked), but two supported flows dissolve
// the binding afterwards:
//   * account deletion (server/account-deletion.mjs) deletes every
//     member_accounts row for the account and deactivates the account,
//     while the connection journal is retained by policy;
//   * a self-left member's account rejoining under a new member id
//     (store.mjs acceptInvitation) deletes the left member's binding.
// Either flow made the room's connection journal fail integrity forever
// with connection_integrity_error (production's integrity job has
// failed continuously since 2026-10-11). A missing binding is now
// explained only by a terminal fact — the sponsor account deactivated
// or the sponsor member inactive — while a binding naming a different
// account, and a missing binding with both parties still active, are
// still rejected.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { planAccountDeletion, executeAccountDeletion } from "../server/account-deletion.mjs";

function fixture(t) {
  const now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom());
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const session = store.createSession(ownerKey);
  const rooms = new AgentRooms(store);
  const create = (token, binding, expectedOwnerRevision) => store.agentConnections.apply(token, "commons", {
    action: "create", requestId: randomUUID(), memberId: "agent-one", displayName: "Agent One",
    access: "collaborate", keyHash: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("hex"),
    expiresAt: now + 3600000, expectedOwnerRevision
  }, binding);
  const addHuman = (memberId, accountId) => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "human", permissions: ["manage_members"] } });
    store.createAccount(accountId);
    store.bindHumanAccount("commons", memberId, accountId);
    const key = store.issueAccessKey("commons", memberId);
    return store.createSession(key);
  };
  const sponsorAccountId = () => store.db.prepare("SELECT sponsor_account_id FROM agent_connections LIMIT 1").get().sponsor_account_id;
  const deleteSponsorAccount = () => executeAccountDeletion(store, planAccountDeletion(store, sponsorAccountId()).plan);
  return { store, ownerKey, session, rooms, create, addHuman, sponsorAccountId, deleteSponsorAccount, now };
}

test("connection history verifies after the sponsor transfers ownership and deletes their account", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  f.addHuman("human-two", "human-two-acct");
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  f.deleteSponsorAccount();
  // The dissolution is real: the binding row is gone and the account is
  // deactivated, but the journal is retained by deletion policy.
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM member_accounts WHERE member_id='owner'").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT active FROM accounts WHERE id=?").get(f.sponsorAccountId()).active, 0);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("connection history verifies after the sponsor-owner deletes their account (personal room archived)", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  f.deleteSponsorAccount();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM member_accounts WHERE member_id='owner'").get().n, 0);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("connection history verifies after a self-left sponsor's account rejoins under a new member id", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  const two = f.addHuman("human-two", "human-two-acct");
  f.rooms.transfer(f.session.token, "commons", { toMemberId: "human-two" }, f.session.session.sessionBinding);
  // The sponsor leaves on their own (actor == member): the binding is
  // retained, and history still verifies.
  const sponsor = f.store.room("commons").state.members.owner;
  f.store.command(f.ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: sponsor.revision, active: false, permissions: sponsor.permissions } });
  assert.doesNotThrow(() => f.store.agentConnections.verify());
  // The same account rejoins through an invitation as a NEW member id;
  // acceptance deletes the left member's binding while the account
  // itself stays active.
  const raw = randomBytes(32).toString("base64url");
  f.store.issueInvitation(two.token, "commons", {
    requestId: "rejoin-invite", token: raw, intendedAccountId: f.sponsorAccountId(), intendedMemberId: "owner-returned",
    displayName: "Owner Returned", role: "member", expiresAt: f.now + 3600000,
    expectedIssuerMemberRevision: f.store.room("commons").state.members["human-two"].revision,
    expectedSessionBinding: two.session.sessionBinding
  });
  const accessKey = f.store.issueAccountAccessKey(f.sponsorAccountId());
  const slot = f.store.createAccountSessionSlot();
  const sponsorSession = f.store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision);
  f.store.acceptInvitation(slot.token, raw, { redemptionId: randomUUID(), expectedRevision: 0, expectedSessionBinding: sponsorSession.sessionBinding });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM member_accounts WHERE member_id='owner'").get().n, 0);
  assert.equal(f.store.db.prepare("SELECT active FROM accounts WHERE id=?").get(f.sponsorAccountId()).active, 1);
  assert.doesNotThrow(() => f.store.agentConnections.verify());
});

test("a binding repointed to a different account is still rejected", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  f.store.createAccount("other-acct");
  f.store.db.prepare("UPDATE member_accounts SET account_id='other-acct' WHERE member_id='owner'").run();
  assert.throws(() => f.store.agentConnections.verify(), { code: "connection_integrity_error" });
});

test("a binding deleted with the sponsor member and account both active is still rejected", t => {
  const f = fixture(t);
  f.create(f.session.token, f.session.session.sessionBinding, 0);
  // No legitimate dissolution happened — neither account deletion nor a
  // self-leave — so a missing binding remains corrupt history.
  f.store.db.prepare("DELETE FROM member_accounts WHERE member_id='owner'").run();
  assert.throws(() => f.store.agentConnections.verify(), { code: "connection_integrity_error" });
});
