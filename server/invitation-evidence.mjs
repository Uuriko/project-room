import { createHash } from "node:crypto";
import { event, EVENT_TYPES as T, ownMember, MEMBERSHIP_AUTHORITY_POLICY_VERSION, DISPLAY_NAME_POLICY_VERSION } from "../src/events.js";
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
      authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
      displayNamePolicyVersion: DISPLAY_NAME_POLICY_VERSION,
      // A targeted-invitation rejoin supersedes the account's self-left
      // member record; acceptInvitation computes it from the event log
      // (memberSelfLeft) and names it here so the v3 roster check spares
      // exactly that record. Absent for ordinary first joins.
      ...(record.rejoinOfMemberId ? { rejoinOfMemberId: record.rejoinOfMemberId } : {})
    }
  });
}

export function assertInvitationMembershipEvidence(record, linked, binding, room, { retiredInvitee = false } = {}) {
  const member = ownMember(room?.state.members, record.intended_member_id);
  const origin = { kind: "invitation", invitationId: record.id, invitedByMemberId: record.issuer_member_id };
  const joined = linked && JSON.parse(linked.body);
  // W4-NEW-1 added displayNamePolicyVersion to newly issued joined events.
  // Events written before that field existed are legitimate history: compare
  // against the event shape their era produced rather than failing the
  // upgrade integrity sweep.
  const expected = invitationJoinedEvent(record);
  if (joined?.data && !("displayNamePolicyVersion" in joined.data)) delete expected.data.displayNamePolicyVersion;
  // A joined event stamped with an earlier display-name policy (v1 before r50's
  // v2, v2 before the v3 removed-member reservation) is that era's shape too:
  // the expected event takes the joined event's own stamp. Unknown stamps are
  // not normalised away — they still mismatch and fail the sweep.
  else if ([1, 2, 3].includes(joined?.data?.displayNamePolicyVersion)) expected.data.displayNamePolicyVersion = joined.data.displayNamePolicyVersion;
  // A rejoin's joined event names the self-left record it superseded; that
  // field is part of the event's own shape, so the expected event takes it —
  // but only after cross-checking the member record (MICRO-4348 N2): the
  // named record must be a distinct, inactive member of this room. A stored
  // event naming a nonexistent, still-active, or self record is not a
  // legitimate rejoin shape; leaving the field out of the expected event
  // makes the canonical comparison refuse it instead of blessing it.
  if (typeof joined?.data?.rejoinOfMemberId === "string") {
    const superseded = ownMember(room?.state?.members, joined.data.rejoinOfMemberId);
    if (superseded && superseded.id !== record.intended_member_id && superseded.active === false) {
      expected.data.rejoinOfMemberId = joined.data.rejoinOfMemberId;
    }
  }
  if (!linked || linked.id !== record.joined_event_id || linked.room_id !== record.room_id
    || !Number.isSafeInteger(linked.sequence) || linked.sequence < 1 || linked.sequence > room.sequence
    || canonicalInvitationData(joined) !== canonicalInvitationData(expected)
    // A deleted invitee has no member_accounts binding and a scrubbed live
    // membership; the immutable joined event above is still verified.
    || (!retiredInvitee && (binding?.account_id !== record.intended_account_id || binding.origin !== `invitation:${record.id}`
    || member?.id !== record.intended_member_id || member.kind !== "human"
    || member.displayName !== record.intended_display_name || member.role !== record.intended_role
    || member.accountableHumanId !== record.intended_member_id
    || canonicalInvitationData(member.membershipOrigin) !== canonicalInvitationData(origin)))) {
    throw new Error("Membership evidence differs from journal");
  }
  // Permissions, active state, and revision can legitimately change after joining.
  // Their current authorization is checked separately by the service.
}
