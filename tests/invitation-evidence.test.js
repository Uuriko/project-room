import test from "node:test";
import assert from "node:assert/strict";
import { invitationJoinedEvent, assertInvitationMembershipEvidence } from "../server/invitation-evidence.mjs";

function fixture() {
  const record = { id: "offer", joined_event_id: "join", redemption_id: "local-receipt",
    room_id: "room", intended_member_id: "member", intended_account_id: "account",
    intended_display_name: "Member", intended_role: "guest", intended_permissions_json: "[]",
    issuer_member_id: "owner", role_policy_version: 1, accepted_at: 1000 };
  const origin = { kind: "invitation", invitationId: "offer", invitedByMemberId: "owner" };
  const member = { id: "member", kind: "human", displayName: "Member", role: "guest",
    accountableHumanId: "member", membershipOrigin: origin, permissions: [], active: true, revision: 0 };
  const linked = { id: "join", room_id: "room", sequence: 3, body: JSON.stringify(invitationJoinedEvent(record)) };
  const binding = { account_id: "account", origin: "invitation:offer" };
  const room = { sequence: 3, state: { members: { member } } };
  return { record, linked, binding, room, member };
}

test("acceptance evidence has a deterministic complete public envelope without private account identity", () => {
  const f = fixture(), joined = invitationJoinedEvent(f.record);
  assert.deepEqual(Object.keys(joined).sort(), ["actorId", "at", "causationId", "data", "id", "idempotencyKey", "roomId", "type"]);
  assert.equal(joined.causationId, null);
  assert.deepEqual(joined, invitationJoinedEvent(f.record));
  assert.equal(JSON.stringify(joined).includes('"account"'), false);
  assert.doesNotThrow(() => assertInvitationMembershipEvidence(f.record, f.linked, f.binding, f.room));
});

test("evidence contract requires each envelope field and immutable member field", () => {
  const original = fixture();
  for (const field of Object.keys(JSON.parse(original.linked.body))) {
    const f = fixture(), envelope = JSON.parse(f.linked.body);
    delete envelope[field];
    f.linked.body = JSON.stringify(envelope);
    assert.throws(() => assertInvitationMembershipEvidence(f.record, f.linked, f.binding, f.room), /evidence/, field);
  }
  for (const field of ["id", "kind", "displayName", "role", "accountableHumanId", "membershipOrigin"]) {
    const f = fixture();
    delete f.member[field];
    assert.throws(() => assertInvitationMembershipEvidence(f.record, f.linked, f.binding, f.room), /evidence/, field);
  }
});

test("later access changes do not rewrite the original acceptance evidence", () => {
  const f = fixture();
  Object.assign(f.member, { permissions: ["verify"], active: false, revision: 4 });
  f.room.sequence = 7;
  assert.doesNotThrow(() => assertInvitationMembershipEvidence(f.record, f.linked, f.binding, f.room));
});
