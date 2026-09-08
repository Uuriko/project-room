import { createHash } from "node:crypto";
import { event, EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION } from "../src/events.js";
import { canonicalInvitationData } from "./invitation-journal.mjs";

// One complete receipt contract is shared by issuance of the joined event and audit.
// Keep private account IDs and token material out of the shared event.
export function invitationJoinedEvent(record) {
  return event({
    id: record.joined_event_id,
    idempotencyKey: createHash("sha256").update(`invitation-accept:${record.id}:${record.redemption_id}`).digest("hex"),
    type: T.MEMBER_JOINED_VIA_INVITATION,
    roomId: record.room_id,
    actorId: record.intended_member_id,
    at: new Date(record.accepted_at).toISOString(),
    data: {
      memberId: record.intended_member_id,
      displayName: record.intended_display_name,
      role: record.intended_role,
      permissions: JSON.parse(record.intended_permissions_json),
      invitedByMemberId: record.issuer_member_id,
      invitationId: record.id,
      rolePolicyVersion: record.role_policy_version,
      authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION
    }
  });
}

export function assertInvitationMembershipEvidence(record, linked, binding, room) {
  const member = room?.state.members[record.intended_member_id];
  const origin = { kind: "invitation", invitationId: record.id, invitedByMemberId: record.issuer_member_id };
  const joined = linked && JSON.parse(linked.body);
  if (!linked || linked.id !== record.joined_event_id || linked.room_id !== record.room_id
    || !Number.isSafeInteger(linked.sequence) || linked.sequence < 1 || linked.sequence > room.sequence
    || canonicalInvitationData(joined) !== canonicalInvitationData(invitationJoinedEvent(record))
    || binding?.account_id !== record.intended_account_id || binding.origin !== `invitation:${record.id}`
    || member?.id !== record.intended_member_id || member.kind !== "human"
    || member.displayName !== record.intended_display_name || member.role !== record.intended_role
    || member.accountableHumanId !== record.intended_member_id
    || canonicalInvitationData(member.membershipOrigin) !== canonicalInvitationData(origin)) {
    throw new Error("Membership evidence differs from journal");
  }
  // Permissions, active state, and revision can legitimately change after joining.
  // Their current authorization is checked separately by the service.
}
