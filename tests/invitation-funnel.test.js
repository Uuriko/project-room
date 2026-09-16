import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";
import {
  REDACTED_FIELDS, invitationStatus, invitationFunnel, trueInviteCoefficient, formatInvitationReport
} from "../server/invitation-funnel.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-20T00:00:00.000Z");

const at = (minute) => `2026-09-05T09:${String(minute).padStart(2, "0")}:00.000Z`;
const e = (id, type, actorId, minute, data) => ({
  id, idempotencyKey: `funnel-${id}`, roomId: "room-project-room-v0",
  type, actorId, at: at(minute), causationId: null, data
});
const join = (memberId, minute, invitationId) =>
  e(`evt-join-${memberId}`, EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION, memberId, minute, {
    memberId, displayName: memberId, role: "member",
    permissions: ["accept_work", "complete_work", "verify"],
    invitedByMemberId: "potter", invitationId, rolePolicyVersion: 1, authorityPolicyVersion: 2
  });
const say = (memberId, minute) =>
  e(`evt-say-${memberId}-${minute}`, EVENT_TYPES.MESSAGE_POSTED, memberId, minute, { body: "hello" });

// Nina joins and speaks. Pia joins and never says anything, so she cannot carry
// the loop onward and must not count toward activation.
const roomState = () => replay([
  ...seedEvents, join("nina", 41, "inv-nina"), join("pia", 42, "inv-pia"), say("nina", 44)
]);

// A journal record carries every scope and state key. Sentinel values are used
// for the private fields so the redaction test can look for them by value.
const record = (overrides) => ({
  id: "inv-x", token_hash: "a".repeat(64), room_id: "room-project-room-v0",
  intended_account_id: "acct-SECRET-0001", intended_member_id: "someone",
  intended_display_name: "Private Person Name", intended_role: "member",
  intended_permissions_json: '["accept_work","complete_work","verify"]', role_policy_version: 1,
  issuer_account_id: "acct-SECRET-issuer", issuer_member_id: "potter",
  issuer_account_auth_epoch: 1, issuer_member_revision: 0,
  issue_request_id: "req-1", issue_fingerprint: "b".repeat(64),
  created_at: NOW - 10 * DAY, expires_at: NOW + 4 * DAY,
  revision: 0, status: "pending", accepted_at: null, accepted_by_account_id: null,
  redemption_id: null, joined_event_id: null,
  revoked_at: null, revoked_by_account_id: null, revoked_by_member_id: null, revoke_reason: null,
  ...overrides
});

const journal = () => [
  record({ id: "inv-nina", intended_member_id: "nina", status: "accepted", revision: 1,
    accepted_at: NOW - 10 * DAY + 2 * HOUR, accepted_by_account_id: "acct-SECRET-nina",
    redemption_id: "red-1", joined_event_id: "evt-join-nina" }),
  record({ id: "inv-pia", intended_member_id: "pia", status: "accepted", revision: 1,
    accepted_at: NOW - 10 * DAY + 6 * HOUR, accepted_by_account_id: "acct-SECRET-pia",
    redemption_id: "red-2", joined_event_id: "evt-join-pia" }),
  record({ id: "inv-gone", intended_member_id: "gone", expires_at: NOW - 1 * DAY }),
  record({ id: "inv-live", intended_member_id: "later", expires_at: NOW + 3 * DAY }),
  record({ id: "inv-pulled", intended_member_id: "pulled", status: "revoked", revision: 1,
    revoked_at: NOW - 2 * DAY, revoked_by_account_id: "acct-SECRET-issuer",
    revoked_by_member_id: "potter", revoke_reason: "sent to the wrong person" })
];

test("a pending invitation past its expiry reads as expired, matching the store", () => {
  assert.equal(invitationStatus(record({ expires_at: NOW - 1 }), NOW), "expired");
  assert.equal(invitationStatus(record({ expires_at: NOW + 1 }), NOW), "pending");
  assert.equal(invitationStatus(record({ status: "accepted", expires_at: NOW - 1 }), NOW), "accepted",
    "expiry never overwrites an invitation that was already taken up");
  assert.equal(invitationStatus(record({ status: "revoked", expires_at: NOW - 1 }), NOW), "revoked");
});

test("the funnel counts the send side, including invitations that quietly timed out", () => {
  const funnel = invitationFunnel(journal(), { now: NOW });
  assert.equal(funnel.issued, 5);
  assert.equal(funnel.accepted, 2);
  assert.equal(funnel.expired, 1);
  assert.equal(funnel.pendingLive, 1);
  assert.equal(funnel.revoked, 1);
  assert.equal(funnel.acceptRate, 0.4);
  assert.equal(funnel.expiryLossRate, 0.2);
  assert.equal(funnel.medianTimeToAcceptMs, 4 * HOUR);
  assert.equal(funnel.medianInviteWindowMs, 14 * DAY);
  assert.deepEqual(funnel.byIssuer, [{ issuerMemberId: "potter", issued: 5, accepted: 2, expired: 1 }]);
});

test("more expiries than acceptances is called out as a window problem", () => {
  const rows = [
    record({ id: "a", expires_at: NOW - 1 }),
    record({ id: "b", expires_at: NOW - 1 }),
    record({ id: "c", status: "accepted", revision: 1, accepted_at: NOW - HOUR, joined_event_id: "x" })
  ];
  const funnel = invitationFunnel(rows, { now: NOW });
  assert.equal(funnel.expired, 2);
  assert.ok(funnel.warnings.some((w) => /window or the reminder is wrong/.test(w)));
});

test("K multiplies the three terms and refuses to count a silent joiner", () => {
  const result = trueInviteCoefficient(journal(), roomState(), { now: NOW });
  assert.equal(result.inviters, 1);
  assert.equal(result.issuedPerInviter, 5);
  assert.equal(result.acceptRate, 0.4);
  assert.equal(result.acceptedResolvedToMembers, 2, "both accepted invitations matched a member");
  assert.equal(result.activatedInvitees, 1, "Pia joined and never spoke");
  assert.equal(result.activationRate, 0.5);
  assert.equal(result.k, 1);
});

test("an accepted invitation is matched by joined_event_id when membershipOrigin is absent", () => {
  // Older records predate membershipOrigin; the event id still links them.
  const legacyState = {
    room: { id: "r" },
    members: { legacy: { id: "legacy", kind: "human", active: true, permissions: [] } },
    workItems: {},
    eventLog: [
      { id: "evt-legacy-join", type: EVENT_TYPES.MEMBER_ADDED, actorId: "potter",
        at: "2026-09-05T09:00:00.000Z", data: { memberId: "legacy" } },
      { id: "evt-legacy-say", type: EVENT_TYPES.MESSAGE_POSTED, actorId: "legacy",
        at: "2026-09-05T09:10:00.000Z", data: { body: "hi" } }
    ]
  };
  const rows = [record({ id: "inv-legacy", status: "accepted", revision: 1,
    accepted_at: NOW - DAY, joined_event_id: "evt-legacy-join" })];
  const result = trueInviteCoefficient(rows, legacyState, { now: NOW });
  assert.equal(result.acceptedResolvedToMembers, 1);
  assert.equal(result.activatedInvitees, 1);
});

test("an accepted invitation with no matching member is reported, not silently dropped", () => {
  const rows = [record({ id: "inv-ghost", status: "accepted", revision: 1,
    accepted_at: NOW - DAY, joined_event_id: "evt-nowhere" })];
  const result = trueInviteCoefficient(rows, roomState(), { now: NOW });
  assert.equal(result.acceptedResolvedToMembers, 0);
  assert.ok(result.warnings.some((w) => /could not be matched to a member/.test(w)));
});

test("no private journal field ever reaches the output", () => {
  const result = trueInviteCoefficient(journal(), roomState(), { now: NOW });
  const emitted = JSON.stringify(result) + "\n" + formatInvitationReport(result);
  for (const sentinel of ["a".repeat(64), "b".repeat(64), "acct-SECRET-0001", "acct-SECRET-nina",
    "acct-SECRET-pia", "acct-SECRET-issuer", "Private Person Name", "red-1", "red-2"]) {
    assert.ok(!emitted.includes(sentinel), `output leaked a private journal value: ${sentinel.slice(0, 24)}`);
  }
  // The Room-scoped issuer id is intentionally kept so per-inviter breakdown works.
  assert.ok(emitted.includes("potter"));
});

test("the redaction list is fixed and names the credential fields", () => {
  assert.ok(Object.isFrozen(REDACTED_FIELDS));
  for (const field of ["token_hash", "intended_account_id", "accepted_by_account_id", "intended_display_name"]) {
    assert.ok(REDACTED_FIELDS.includes(field), `${field} must be on the redaction list`);
  }
});

test("no invitations reports nothing rather than guessing", () => {
  const result = trueInviteCoefficient([], roomState(), { now: NOW });
  assert.equal(result.k, null);
  assert.equal(result.acceptRate, null);
  assert.equal(result.insufficientData, true);
  const text = formatInvitationReport(result);
  assert.ok(!/undefined|NaN/.test(text), text);
  assert.ok(text.includes("Read with care"));
});
