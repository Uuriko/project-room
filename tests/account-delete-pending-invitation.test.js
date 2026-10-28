// Deleting an account that holds a PENDING membership invitation (as invitee or
// as issuer) used to fail with a raw SQLite CHECK error because the revoke was
// a bare `SET status='revoked'`. It now revokes through the invitation state
// machine: audit event, journal entry, and the integrity audit stays consistent.
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

function pendingInvite(t) {
  const directory = mkdtempSync(join(tmpdir(), "delete-pending-invite-"));
  const now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = session(store, store.authenticate(store.issueAccessKey("commons", "owner")).account.id);
  store.createAccount("account-target");
  const raw = randomBytes(32).toString("base64url");
  const issued = store.issueInvitation(owner.token, "commons", {
    requestId: "pending-invite", token: raw, intendedAccountId: "account-target", intendedMemberId: "target-member",
    displayName: "Target human", role: "member", expiresAt: now + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision, expectedSessionBinding: owner.session.sessionBinding
  });
  return { store, ownerAccountId: owner.session.account?.id ?? null, id: issued.invitation?.id ?? store.db.prepare("SELECT id FROM membership_invitations LIMIT 1").get().id };
}

test("deleting the invitee revokes their pending invitation instead of failing on a CHECK", t => {
  const { store, id } = pendingInvite(t);
  executeAccountDeletion(store, planAccountDeletion(store, "account-target").plan);
  const row = store.db.prepare("SELECT status,revision,revoked_by_account_id AS by,revoke_reason AS reason FROM membership_invitations WHERE id=?").get(id);
  assert.deepEqual({ ...row }, { status: "revoked", revision: 1, by: "account-target", reason: "account_deleted" });
  const events = store.db.prepare("SELECT type FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(id).map(e => e.type);
  assert.deepEqual(events, ["issued", "revoked"]);
  assert.equal(store.verifyInvitationAudit().consistent, true);
});
