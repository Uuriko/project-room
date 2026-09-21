// v35→v36 migration regression: the v35 revoked-state CHECK required
// revoked_by_account_id IS NOT NULL, so an accountless agent owner could
// issue invitations but never revoke them. v36 rebuilds the invitation
// tables with the relaxed constraint. This test downgrades a real database
// to the exact v35 shape, reopens it, and verifies the migration preserves
// every row and unlocks accountless-owner revocation.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { fenceDefinitions as _fd } from "../server/writer-fence.mjs";

// Exact v35 membership_invitations DDL from main @ d2798965 (the migration's
// "before" shape). INVITATION_ROLE_POLICY_VERSION was 1. The only difference
// from v36 is the revoked-state CHECK: v35 requires revoked_by_account_id
// IS NOT NULL; v36 permits NULL for an accountless agent-owner revoker.
const V35_INVITATIONS_TABLE = `CREATE TABLE membership_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    intended_account_id TEXT NOT NULL REFERENCES accounts(id),
    intended_member_id TEXT NOT NULL,
    intended_display_name TEXT NOT NULL,
    intended_role TEXT NOT NULL CHECK(intended_role IN ('moderator','member','guest')),
    intended_permissions_json TEXT NOT NULL CHECK(json_valid(intended_permissions_json) AND json_type(intended_permissions_json)='array'),
    role_policy_version INTEGER NOT NULL CHECK(role_policy_version=1),
    issuer_account_id TEXT REFERENCES accounts(id),
    issuer_member_id TEXT NOT NULL,
    issuer_account_auth_epoch INTEGER CHECK((issuer_account_id IS NULL) = (issuer_account_auth_epoch IS NULL)),
    issuer_member_revision INTEGER NOT NULL,
    issue_request_id TEXT NOT NULL,
    issue_fingerprint TEXT NOT NULL CHECK(length(issue_fingerprint)=64),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    accepted_by_account_id TEXT REFERENCES accounts(id),
    redemption_id TEXT,
    joined_event_id TEXT UNIQUE REFERENCES events(id),
    revoked_at INTEGER,
    revoked_by_account_id TEXT REFERENCES accounts(id),
    revoked_by_member_id TEXT,
    revoke_reason TEXT,
    CHECK(expires_at>created_at),
    CHECK(
      (status='pending' AND revision=0 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
      OR
      (status='accepted' AND revision=1 AND accepted_at IS NOT NULL AND accepted_by_account_id=intended_account_id AND redemption_id IS NOT NULL AND joined_event_id IS NOT NULL AND revoked_at IS NULL AND revoked_by_account_id IS NULL AND revoked_by_member_id IS NULL AND revoke_reason IS NULL)
      OR
      (status='revoked' AND revision=1 AND accepted_at IS NULL AND accepted_by_account_id IS NULL AND redemption_id IS NULL AND joined_event_id IS NULL AND revoked_at IS NOT NULL AND revoked_by_account_id IS NOT NULL AND revoked_by_member_id IS NOT NULL AND revoke_reason IS NOT NULL)
    )
  )`;

const token = () => randomBytes(32).toString("base64url");

function accountSession(store, accountId) {
  const accessKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision);
  return { token: slot.token, session };
}

function issue(store, ownerToken, sessionBinding, accountId, memberId, requestId, now) {
  return store.issueInvitation(ownerToken, "commons", {
    requestId, token: token(), intendedAccountId: accountId,
    intendedMemberId: memberId, displayName: "Target", role: "member",
    expiresAt: now + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision,
    expectedSessionBinding: sessionBinding
  });
}

test("v35→v36 migration preserves invitation rows and unlocks accountless-owner revocation", async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitation-migration-"));
  const filename = join(directory, "room.sqlite");
  const now = Date.now();
  let store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom());
  const ownerRoomKey = store.issueAccessKey("commons", "owner");
  const ownerAccountId = store.authenticate(ownerRoomKey).account.id;
  const owner = accountSession(store, ownerAccountId);
  store.createAccount("account-target");
  store.createAccount("account-target-2");

  // One pending invitation and one revoked-by-account invitation (v35 shape).
  const pending = issue(store, owner.token, owner.session.sessionBinding, "account-target", "target-pending", "request-pending", now);
  const revoked = issue(store, owner.token, owner.session.sessionBinding, "account-target-2", "target-revoked", "request-revoked", now);
  store.revokeInvitation(owner.token, revoked.invitation.id, {
    expectedRevision: 0, reason: "no longer needed",
    expectedSessionBinding: owner.session.sessionBinding, expectedRoomId: "commons"
  });
  const pendingId = pending.invitation.id, revokedId = revoked.invitation.id;
  store.close();

  // Downgrade the invitation table to the exact v35 shape and version.
  // Save every trigger/index on the table first: ALTER TABLE RENAME would
  // rewrite their SQL to the backup name and trip the writer fence, so the
  // table is dropped and rebuilt with triggers recreated verbatim.
  const raw = new DatabaseSync(filename);
  raw.exec("PRAGMA foreign_keys=OFF");
  // The writer-fence triggers call versioned writer functions; register them
  // on this raw connection so the rebuild below can fire triggers.
  for (let v = 6; v <= 36; v++) raw.function(`project_room_writer_v${v}`, () => v);
  const triggers = raw.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='membership_invitations'").all().map(r => r.sql);
  const indexes = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='membership_invitations' AND sql IS NOT NULL").all().map(r => r.sql);
  raw.exec("CREATE TABLE membership_invitations_backup AS SELECT * FROM membership_invitations");
  raw.exec("DROP TABLE membership_invitations");
  raw.exec(V35_INVITATIONS_TABLE);
  for (const sql of indexes) raw.exec(sql);
  for (const sql of triggers) raw.exec(sql);
  raw.exec("INSERT INTO membership_invitations SELECT * FROM membership_invitations_backup");
  raw.exec("DROP TABLE membership_invitations_backup");
  // A real v35 database has writer_v6..v35 triggers but no writer_v36 ones;
  // drop the v36 fence triggers so the pre-migration fence check passes.
  const v36triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v36_*'").all();
  for (const { name } of v36triggers) raw.exec(`DROP TRIGGER ${name}`);
  raw.exec("PRAGMA user_version=35");
  // A real v35 DB carries the full v35 writer-trigger set; the v36 install
  // only created v36 triggers, so recreate the v35 set for every present table.
  const _present = new Set(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  for (const { name, sql } of _fd(35)) {
    const _table = name.slice("writer_v35_".length).replace(/_(insert|update|delete)$/, "");
    if (_present.has(_table)) raw.exec(sql);
  }
  raw.close();

  // Reopen: the v36 migration runs, then the new capability works.
  store = new RoomStore(filename, { now: () => now });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 36);

  // Both rows survived with every field intact.
  const rows = store.db.prepare("SELECT * FROM membership_invitations ORDER BY id").all();
  assert.equal(rows.length, 2);
  const pendingRow = rows.find(r => r.id === pendingId);
  const revokedRow = rows.find(r => r.id === revokedId);
  assert.equal(pendingRow.status, "pending");
  assert.equal(revokedRow.status, "revoked");
  assert.equal(revokedRow.revoked_by_account_id, ownerAccountId);
  assert.equal(revokedRow.revoked_by_member_id, "owner");
  assert.equal(revokedRow.revoke_reason, "no longer needed");

  // No legacy tables remain; the journal and audit rows survived; FKs are clean.
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_legacy_v35'").get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM membership_invitation_journal").get().n, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM membership_invitation_events").get().n, 3);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(store.verifyInvitationAudit().consistent, true);

  // The v36 capability: the relaxed CHECK now accepts a NULL revoker account.
  // (An accountless agent owner revokes with revoked_by_account_id NULL and
  // the owner member id recorded; the journal carries the authority.)
  const agentIdentity = store.identities.create("Keeper");
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  rooms.create(agentIdentity.secret, {
    roomId: "agent-den", title: "Den", purpose: "migration check", kind: "personal", displayName: "Keeper"
  });
  const agentIssued = store.issueInvitation(agentIdentity.secret, "agent-den", {
    requestId: "request-agent", token: token(), intendedAccountId: "account-target",
    intendedMemberId: "target-agent", displayName: "Target", role: "member",
    expiresAt: now + 3600000, expectedIssuerMemberRevision: 0, expectedSessionBinding: null
  });
  const agentRevoked = store.revokeInvitation(agentIdentity.secret, agentIssued.invitation.id, {
    expectedRevision: 0, reason: "owner decision", expectedSessionBinding: null, expectedRoomId: "agent-den"
  });
  assert.equal(agentRevoked.invitation.status, "revoked");
  const agentRow = store.db.prepare("SELECT revoked_by_account_id,revoked_by_member_id FROM membership_invitations WHERE id=?").get(agentIssued.invitation.id);
  assert.equal(agentRow.revoked_by_account_id, null);
  assert.equal(agentRow.revoked_by_member_id, agentIdentity.identityId);
  assert.equal(store.verifyInvitationAudit().consistent, true);
});
