import { createHash } from "node:crypto";
import { INVITATION_ROLE_POLICIES, validId } from "../src/events.js";

// Private authority history: never include this module or its records in browser assets.
// Checksums detect inconsistencies; they do not authenticate a database administrator.
export const canonicalInvitationData = value => Array.isArray(value) ? `[${value.map(canonicalInvitationData).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalInvitationData(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonicalInvitationData(value)).digest("hex");
const assert = condition => { if (!condition) throw new Error("Invitation journal consistency check failed"); };
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const equal = (left, right) => canonicalInvitationData(left) === canonicalInvitationData(right);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bounded = (value, max) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
const hashPattern = /^[a-f0-9]{64}$/;
const scopeKeys = "id token_hash room_id intended_account_id intended_member_id intended_display_name intended_role intended_permissions_json role_policy_version issuer_account_id issuer_member_id issuer_account_auth_epoch issuer_member_revision issue_request_id issue_fingerprint created_at expires_at".split(" ");
const stateKeys = "revision status accepted_at accepted_by_account_id redemption_id joined_event_id revoked_at revoked_by_account_id revoked_by_member_id revoke_reason".split(" ");
const auditKeys = "invitation_id sequence type actor_account_id actor_member_id actor_auth_epoch actor_session_revision invitation_revision at room_event_id reason".split(" ");
const entryKeys = "version invitationId sequence kind recordedAt previousHash record audits".split(" ");
const nullFields = (record, fields) => fields.every(field => record[field] === null);
const acceptKeys = "accepted_at accepted_by_account_id redemption_id joined_event_id".split(" ");
const revokeKeys = "revoked_at revoked_by_account_id revoked_by_member_id revoke_reason".split(" ");

export const invitationJournalSchema = `
  CREATE TABLE membership_invitation_journal (
    invitation_id TEXT NOT NULL REFERENCES membership_invitations(id),
    sequence INTEGER NOT NULL CHECK(sequence>0),
    body TEXT NOT NULL CHECK(json_valid(body)),
    checksum TEXT NOT NULL CHECK(length(checksum)=64),
    PRIMARY KEY(invitation_id,sequence)
  );
  CREATE TRIGGER membership_invitation_journal_no_update BEFORE UPDATE ON membership_invitation_journal
    BEGIN SELECT RAISE(ABORT,'invitation journal is append-only'); END;
  CREATE TRIGGER membership_invitation_journal_no_delete BEFORE DELETE ON membership_invitation_journal
    BEGIN SELECT RAISE(ABORT,'invitation journal is append-only'); END;
`;

export function validateInvitationSnapshot(record, audits) {
  assert(exact(record, [...scopeKeys, ...stateKeys]));
  for (const key of ["id", "room_id", "intended_account_id", "intended_member_id", "issuer_account_id", "issuer_member_id", "issue_request_id"]) assert(validId(record[key]));
  for (const key of ["token_hash", "issue_fingerprint"]) assert(typeof record[key] === "string" && hashPattern.test(record[key]));
  for (const key of ["issuer_account_auth_epoch", "issuer_member_revision", "created_at", "expires_at"]) assert(integer(record[key]));
  assert(bounded(record.intended_display_name, 256) && record.expires_at > record.created_at);
  const policy = INVITATION_ROLE_POLICIES[record.role_policy_version];
  assert(policy && Object.hasOwn(policy, record.intended_role));
  const permissions = JSON.parse(record.intended_permissions_json);
  assert(equal(permissions, policy[record.intended_role]));
  assert(record.issue_fingerprint === digest({
    roomId: record.room_id, requestId: record.issue_request_id, tokenHash: record.token_hash,
    intendedAccountId: record.intended_account_id, intendedMemberId: record.intended_member_id,
    displayName: record.intended_display_name, role: record.intended_role, permissions,
    expiresAt: record.expires_at, expectedIssuerMemberRevision: record.issuer_member_revision
  }));
  assert(Array.isArray(audits) && audits.length === (record.status === "pending" ? 1 : 2));
  for (const [index, audit] of audits.entries()) {
    assert(exact(audit, auditKeys) && audit.invitation_id === record.id && audit.sequence === index + 1);
    assert(validId(audit.actor_account_id) && validId(audit.actor_member_id));
    assert(integer(audit.actor_auth_epoch) && integer(audit.actor_session_revision) && integer(audit.at));
  }
  const first = audits[0];
  assert(first.type === "issued" && first.invitation_revision === 0 && first.at === record.created_at);
  assert(first.actor_account_id === record.issuer_account_id && first.actor_member_id === record.issuer_member_id && first.actor_auth_epoch === record.issuer_account_auth_epoch);
  assert(first.room_event_id === null && first.reason === null);
  if (record.status === "pending") {
    assert(record.revision === 0 && nullFields(record, [...acceptKeys, ...revokeKeys]));
  } else {
    const last = audits[1];
    assert(record.revision === 1 && last.invitation_revision === 1 && last.type === record.status);
    if (record.status === "accepted") {
      assert(integer(record.accepted_at) && record.accepted_at < record.expires_at && record.accepted_by_account_id === record.intended_account_id);
      assert(typeof record.redemption_id === "string" && /^(?:[A-Za-z0-9_-]{43}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(record.redemption_id));
      assert(validId(record.joined_event_id) && nullFields(record, revokeKeys));
      assert(last.actor_account_id === record.intended_account_id && last.actor_member_id === record.intended_member_id);
      assert(last.at === record.accepted_at && last.room_event_id === record.joined_event_id && last.reason === null);
    } else {
      assert(record.status === "revoked" && integer(record.revoked_at));
      assert(validId(record.revoked_by_account_id) && validId(record.revoked_by_member_id) && bounded(record.revoke_reason, 4096));
      assert(nullFields(record, acceptKeys) && last.at === record.revoked_at && last.room_event_id === null && last.reason === record.revoke_reason);
      assert(last.actor_account_id === record.revoked_by_account_id && last.actor_member_id === record.revoked_by_member_id);
    }
  }
}

export function invitationJournalEntry(record, audits, kind, recordedAt, prior = null) {
  const entry = {
    version: 1, invitationId: record.id, sequence: prior ? prior.sequence + 1 : 1,
    kind, recordedAt, previousHash: prior?.checksum ?? null, record, audits
  };
  return { invitation_id: record.id, sequence: entry.sequence, body: canonicalInvitationData(entry), checksum: digest(entry) };
}

// Reconstruct solely from the private journal, not the mutable invitation projection.
// Legacy baseline provenance remains explicit through every later transition.
export function replayInvitationJournal(rows) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 2);
  let previous = null, checksum = null, legacyBaseline = false;
  for (const [index, row] of rows.entries()) {
    const entry = JSON.parse(row.body);
    assert(exact(entry, entryKeys) && entry.version === 1 && integer(entry.recordedAt));
    assert(row.invitation_id === entry.invitationId && row.sequence === index + 1 && entry.sequence === row.sequence);
    assert(entry.record.id === entry.invitationId && entry.previousHash === checksum && row.checksum === digest(entry));
    validateInvitationSnapshot(entry.record, entry.audits);
    if (!previous) {
      assert(entry.kind === "legacy-v4-baseline" || (entry.kind === "issued" && entry.record.status === "pending"));
      legacyBaseline = entry.kind === "legacy-v4-baseline";
    } else {
      assert(previous.record.status === "pending" && ["accepted", "revoked"].includes(entry.kind) && entry.record.status === entry.kind);
      assert(scopeKeys.every(key => equal(previous.record[key], entry.record[key])));
      assert(equal(previous.audits, entry.audits.slice(0, 1)));
    }
    previous = entry;
    checksum = row.checksum;
  }
  return { record: previous.record, audits: previous.audits, legacyBaseline, journalSequence: previous.sequence, checksum };
}
