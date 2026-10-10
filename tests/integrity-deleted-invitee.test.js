// Prod integrity job failed every hour from 05:30Z Oct 10 with "Invitation
// record requires operator reconciliation" (wrangler tail, 08:00Z tick). Cause:
// account deletion removes the invitee's member_accounts binding, and the
// accepted-invitation evidence check still demanded it. A deleted invitee now
// verifies; a missing binding for a live account is still refused.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { executeAccountDeletion, planAccountDeletion } from "../server/account-deletion.mjs";

function session(store, accountId) {
  const accessKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  return { token: slot.token, session: store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision) };
}

function acceptedInvite(t) {
  const directory = mkdtempSync(join(tmpdir(), "integrity-deleted-invitee-"));
  const now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = session(store, store.authenticate(store.issueAccessKey("commons", "owner")).account.id);
  store.createAccount("account-target");
  const target = session(store, "account-target");
  const raw = randomBytes(32).toString("base64url");
  store.issueInvitation(owner.token, "commons", {
    requestId: "integrity-invite", token: raw, intendedAccountId: "account-target", intendedMemberId: "target-member",
    displayName: "Target human", role: "member", expiresAt: now + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision, expectedSessionBinding: owner.session.sessionBinding
  });
  store.acceptInvitation(target.token, raw, { redemptionId: crypto.randomUUID(), expectedRevision: 0, expectedSessionBinding: target.session.sessionBinding });
  assert.equal(store.verifyInvitationAudit().consistent, true);
  return store;
}

test("a deleted invitee's accepted invitation still passes the full integrity audit", t => {
  const store = acceptedInvite(t);
  executeAccountDeletion(store, planAccountDeletion(store, "account-target").plan);
  assert.equal(store.account("account-target").active, false);
  const audit = store.verifyInvitationAudit();
  assert.equal(audit.consistent, true);
  assert.equal(audit.invitations, 1);
});

test("a live invitee whose membership binding vanished is still refused", t => {
  const store = acceptedInvite(t);
  store.db.prepare("DELETE FROM member_accounts WHERE account_id=?").run("account-target");
  assert.throws(() => store.verifyInvitationAudit(), /operator reconciliation/);
});
