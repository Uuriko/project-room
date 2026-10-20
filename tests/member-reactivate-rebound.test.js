// r126 rebound guard (John's Tab, muse-room seq 16444; specimen carrier
// hash-verified against the sha256 published in that post). An invited human
// who self-left and came back through a newer invitation handed their account
// binding to the NEW member; the old member keeps no binding. Reactivating
// that old member would leave an active human with no account binding, and
// every later invitation audit (cold start, backup, export, the integrity
// job) then fails on its record with "Invitation record requires operator
// reconciliation". The store refuses that reactivation 409
// membership_rebound; the newer membership is the one to change instead.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Targeted invitations (issueInvitation / acceptInvitation), one human
// account invited twice: first as friend-1, then — after friend-1 self-left —
// again as the new member friend-2.
function targeted(t) {
  const directory = mkdtempSync(pathJoin(tmpdir(), "room-rejoin-targeted-"));
  const now = Date.now();
  const store = new RoomStore(pathJoin(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const session = accountId => { const accessKey = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot(); return { token: slot.token, session: store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision) }; };
  const owner = session(store.authenticate(store.issueAccessKey("commons", "owner")).account.id);
  store.createAccount("account-friend");
  const friend = session("account-friend");
  const invite = (requestId, memberId, role = "member") => {
    const token = randomBytes(32).toString("base64url");
    store.issueInvitation(owner.token, "commons", { requestId, token, intendedAccountId: "account-friend", intendedMemberId: memberId, displayName: "Target human", role,
      expiresAt: now + 3600000, expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision, expectedSessionBinding: owner.session.sessionBinding });
    return token;
  };
  const accept = token => store.acceptInvitation(friend.token, token, { redemptionId: randomUUID(), expectedRevision: 0, expectedSessionBinding: friend.session.sessionBinding });
  const members = () => store.room("commons").state.members;
  const setActive = (actorKey, memberId, active) => { const m = members()[memberId]; store.command(actorKey, "commons", { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED, data: { memberId, expectedMemberRevision: m.revision, permissions: [...m.permissions], active } }); };
  return { store, invite, accept, members, setActive };
}

test("the owner cannot reactivate a self-left member whose account came back as a newer member", t => {
  const { store, invite, accept, members, setActive } = targeted(t);
  accept(invite("first", "friend-1"));
  setActive(store.issueAccessKey("commons", "friend-1"), "friend-1", false);
  accept(invite("second", "friend-2"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  assert.throws(() => setActive(ownerKey, "friend-1", true), error => error.status === 409 && error.code === "membership_rebound");
  assert.equal(members()["friend-1"].active, false);
  assert.equal(store.verifyInvitationAudit().consistent, true);
});

test("still refused after the newer member leaves too; the newer membership is the one to bring back", t => {
  const { store, invite, accept, members, setActive } = targeted(t);
  accept(invite("first", "friend-1"));
  setActive(store.issueAccessKey("commons", "friend-1"), "friend-1", false);
  accept(invite("second", "friend-2"));
  setActive(store.issueAccessKey("commons", "friend-2"), "friend-2", false);
  const ownerKey = store.issueAccessKey("commons", "owner");
  assert.throws(() => setActive(ownerKey, "friend-1", true), error => error.status === 409 && error.code === "membership_rebound");
  assert.equal(store.verifyInvitationAudit().consistent, true);
  setActive(ownerKey, "friend-2", true);
  assert.equal(members()["friend-2"].active, true);
  assert.equal(store.verifyInvitationAudit().consistent, true);
});

test("the owner can still reactivate a self-left member who never came back", t => {
  const { store, invite, accept, members, setActive } = targeted(t);
  accept(invite("first", "friend-1"));
  setActive(store.issueAccessKey("commons", "friend-1"), "friend-1", false);
  setActive(store.issueAccessKey("commons", "owner"), "friend-1", true);
  assert.equal(members()["friend-1"].active, true);
  assert.equal(store.verifyInvitationAudit().consistent, true);
});
