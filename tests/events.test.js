import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, WORK_STATES, applyEvent, event, replay } from "../src/events.js";
import { seedEvents } from "../src/seed.js";

const ROOM_ID = "room-project-room-v0";
const baseState = () => replay(seedEvents);

test("seed replay reconstructs the reviewed contract deterministically", () => {
  const first = replay(seedEvents);
  const second = replay(seedEvents);
  assert.deepEqual(first, second);
  assert.equal(first.workItems["work-spec-review"].state, WORK_STATES.COMPLETED);
  assert.equal(first.workItems["work-spec-review"].verification.result, "pass");
  assert.equal(first.workItems["work-spec-review"].receipt.producerId, "codex");
  assert.equal(first.workItems["work-spec-review"].verification.independenceConfirmed, true);
  assert.equal(first.workItems["work-spec-review"].decision, null);
  assert.equal(first.workItems["work-vertical-slice"].state, WORK_STATES.WORKING);
});

test("an exact duplicate event is idempotent", () => {
  const state = baseState();
  const posted = fixedEvent("event-once", EVENT_TYPES.MESSAGE_POSTED, "potter", { body: "Only once" });
  const once = applyEvent(state, posted);
  const twice = applyEvent(once, posted);
  assert.equal(once.messages.length, state.messages.length + 1);
  assert.equal(twice.messages.length, once.messages.length);
});

test("room conversation can address a human or agent without creating work", () => {
  const state = baseState();
  const workBefore = Object.keys(state.workItems).length;
  const next = applyEvent(state, fixedEvent("directed-room-message", EVENT_TYPES.MESSAGE_POSTED, "maya", {
    body: "Instinct, what do you think about this?",
    toMemberId: "instinct"
  }));
  assert.equal(next.messages.at(-1).toMemberId, "instinct");
  assert.equal(Object.keys(next.workItems).length, workBefore);
});

test("invitation acceptance records the joining human as actor without granting its inviter's authority", () => {
  const state = baseState();
  const joined = fixedEvent("joined-from-invitation", EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION, "new-human", {
    memberId: "new-human",
    displayName: "New human",
    role: "guest",
    permissions: [],
    invitedByMemberId: "potter",
    invitationId: "invite-new-human",
    rolePolicyVersion: 1,
    authorityPolicyVersion: 2
  });
  const next = applyEvent(state, joined);
  assert.deepEqual(next.members["new-human"], {
    id: "new-human", displayName: "New human", kind: "human", role: "guest",
    accountableHumanId: "new-human", permissions: [], availability: "unknown", active: true, revision: 0,
    membershipOrigin: { kind: "invitation", invitationId: "invite-new-human", invitedByMemberId: "potter" }
  });
  assert.equal(next.eventLog.at(-1).actorId, "new-human");
  assert.throws(() => applyEvent(state, { ...joined, id: "wrong-actor", idempotencyKey: "wrong-actor", actorId: "potter" }), /join as themself/);
  assert.throws(() => applyEvent(state, { ...joined, id: "wrong-grants", idempotencyKey: "wrong-grants", data: { ...joined.data, permissions: ["manage_members"] } }), /role permissions/);
});

test("a room message can become linked accountable work without copied context", () => {
  const state = baseState();
  const next = applyEvent(state, fixedEvent("conversation-to-work", EVENT_TYPES.WORK_PROPOSED, "potter", {
    workItemId: "work-from-conversation",
    title: "Explore the room idea",
    definitionOfDone: "Return a source-linked recommendation",
    accountableMemberId: "maya",
    verifierMemberId: "instinct",
    independentVerificationRequired: true,
    ownerDecisionRequired: true,
    humanDecisionMakerId: "potter",
    mode: "read",
    sourceMessageId: "evt-message-2"
  }));
  assert.equal(next.workItems["work-from-conversation"].sourceMessageId, "evt-message-2");
  assert.equal(next.messages.find((message) => message.id === "evt-message-2").body, "Yes. Conversation should be worth having here even before it becomes a task.");
});

test("conflicting reuse of an event id or idempotency key is rejected", () => {
  const state = applyEvent(baseState(), fixedEvent("conflict", EVENT_TYPES.MESSAGE_POSTED, "potter", { body: "First" }));
  assert.throws(() => applyEvent(state, fixedEvent("conflict", EVENT_TYPES.MESSAGE_POSTED, "potter", { body: "Changed" })), /Conflicting reuse of event id/);
  const sameKey = { ...fixedEvent("different-id", EVENT_TYPES.MESSAGE_POSTED, "potter", { body: "Changed" }), idempotencyKey: "key-conflict" };
  assert.throws(() => applyEvent(state, sameKey), /Conflicting reuse of idempotency key/);
});

test("a stale revision fails without mutating the projection or event log", () => {
  const state = baseState();
  const before = structuredClone(state);
  assert.throws(() => applyEvent(state, fixedEvent("stale-complete", EVENT_TYPES.WORK_COMPLETED, "codex", {
    workItemId: "work-vertical-slice",
    expectedRevision: 1,
    summary: "Stale result",
    evidenceUrl: "https://github.com/Uuriko/project-room",
    evidenceVersion: "stale",
    nextAction: "Do not record"
  })), /Stale Work Item revision/);
  assert.deepEqual(state, before);
});

test("read-only work starts without a claim", () => {
  let state = baseState();
  state = applyEvent(state, proposal("read-proposed", "work-read", "codex", "instinct", "read"));
  state = applyEvent(state, workEvent("read-accepted", EVENT_TYPES.WORK_ACCEPTED, "codex", "work-read", 0));
  state = applyEvent(state, workEvent("read-started", EVENT_TYPES.WORK_STARTED, "codex", "work-read", 1));
  assert.equal(state.workItems["work-read"].state, WORK_STATES.WORKING);
  assert.equal(state.workItems["work-read"].claim, null);
});

test("a contested write cannot start without a current exact-scope claim", () => {
  let state = baseState();
  state = applyEvent(state, proposal("write-proposed", "work-write", "codex", "instinct", "write"));
  state = applyEvent(state, workEvent("write-accepted", EVENT_TYPES.WORK_ACCEPTED, "codex", "work-write", 0));
  assert.throws(() => applyEvent(state, workEvent("write-started", EVENT_TYPES.WORK_STARTED, "codex", "work-write", 1)), /current exact-scope claim/);
});

test("a claim cannot create write permission", () => {
  let state = baseState();
  state = applyEvent(state, proposal("noauth-proposed", "work-noauth", "instinct", "codex", "write"));
  state = applyEvent(state, workEvent("noauth-accepted", EVENT_TYPES.WORK_ACCEPTED, "instinct", "work-noauth", 0));
  assert.throws(() => applyEvent(state, workEvent("noauth-claim", EVENT_TYPES.CLAIM_ACQUIRED, "instinct", "work-noauth", 1, {
    repository: "Uuriko/project-room",
    ref: "instinct/test",
    paths: ["src/**"],
    expiresAt: "2026-09-06T10:00:00.000Z"
  })), /lacks write_external/);
});

test("read-only work rejects a write claim", () => {
  let state = baseState();
  state = applyEvent(state, proposal("read-claim-proposed", "work-read-claim", "codex", "instinct", "read"));
  state = applyEvent(state, workEvent("read-claim-accepted", EVENT_TYPES.WORK_ACCEPTED, "codex", "work-read-claim", 0));
  assert.throws(() => applyEvent(state, workEvent("read-claim", EVENT_TYPES.CLAIM_ACQUIRED, "codex", "work-read-claim", 1, {
    repository: "Uuriko/project-room",
    ref: "codex/test",
    paths: ["src/**"],
    expiresAt: "2026-09-06T10:00:00.000Z"
  })), /Read-only work/);
});

test("completion records a result but not verification", () => {
  const state = completeBuild(baseState(), "abc123", "build-completed", { producerId: null });
  const item = state.workItems["work-vertical-slice"];
  assert.equal(item.state, WORK_STATES.COMPLETED);
  assert.equal(item.verification, null);
  assert.equal(item.receipt.evidenceVersion, "abc123");
  assert.equal(item.receipt.reportedById, "codex");
  assert.equal(item.receipt.producerId, null);
  assert.equal(item.receipt.producerAttribution, "unknown");
});

test("completion keeps the authenticated reporter separate from reported producer attribution", () => {
  const state = completeBuild(baseState(), "abc123", "produced-completed", { producerId: "maya" });
  const receipt = state.workItems["work-vertical-slice"].receipt;
  assert.equal(receipt.reportedById, "codex");
  assert.equal(receipt.producerId, "maya");
  assert.equal(receipt.producerAttribution, "reported");
  assert.throws(() => completeBuild(baseState(), "abc123", "outsider-completed", { producerId: "outsider" }), /Unknown member: outsider/);
});

test("a known producer cannot independently verify their own result", () => {
  const state = completeBuild(baseState(), "abc123", "self-produced", { producerId: "instinct" });
  const item = state.workItems["work-vertical-slice"];
  assert.throws(() => applyEvent(state, workEvent("self-verification", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", item.id, item.revision, {
    result: "pass",
    completionEventId: item.receipt.eventId,
    evidenceVersion: item.receipt.evidenceVersion,
    summary: "Checking my own output"
  })), /different from the known producer/);
  assert.equal(item.verification, null);
});

test("PASS is separate per-version evidence and does not become a work state", () => {
  let state = completeBuild(baseState(), "abc123", "pass-completed");
  const revision = state.workItems["work-vertical-slice"].revision;
  state = applyEvent(state, workEvent("pass-verification", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", "work-vertical-slice", revision, {
    result: "pass",
    completionEventId: "pass-completed",
    evidenceVersion: "abc123",
    summary: "Exact version passes"
  }));
  const item = state.workItems["work-vertical-slice"];
  assert.equal(item.state, WORK_STATES.COMPLETED);
  assert.equal(item.verification.result, "pass");
  assert.equal(item.receipt.producerId, "codex");
  assert.equal(item.receipt.producerAttribution, "reported");
  assert.equal(item.verification.independenceConfirmed, true);
});

test("a PASS against an unknown producer remains non-independent and cannot unlock approval", () => {
  let state = completeBuild(baseState(), "abc123", "unknown-producer-completed", { producerId: null });
  let item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, workEvent("unknown-producer-pass", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", item.id, item.revision, {
    result: "pass",
    completionEventId: item.receipt.eventId,
    evidenceVersion: item.receipt.evidenceVersion,
    summary: "The exact artifact passed, but its producer is unknown"
  }));
  item = state.workItems[item.id];
  assert.equal(item.verification.result, "pass");
  assert.equal(item.verification.independenceConfirmed, false);
  assert.equal(item.receipt.producerAttribution, "unknown");
  assert.throws(
    () => applyEvent(state, ownerDecision("unknown-producer-approval", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved")),
    /confirmed producer independence/
  );
  const inconsistent = structuredClone(state);
  inconsistent.workItems[item.id].verification.independenceConfirmed = true;
  assert.throws(
    () => applyEvent(inconsistent, ownerDecision("forged-independence-approval", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved")),
    /confirmed producer independence/
  );
});

test("only the designated verifier may check the exact current completion", () => {
  const state = completeBuild(baseState(), "abc123", "exact-completed");
  const revision = state.workItems["work-vertical-slice"].revision;
  assert.throws(() => applyEvent(state, workEvent("wrong-verifier", EVENT_TYPES.VERIFICATION_RECORDED, "potter", "work-vertical-slice", revision, {
    result: "pass", completionEventId: "exact-completed", evidenceVersion: "abc123", summary: "Looks fine"
  })), /designated verifier/);
  assert.throws(() => applyEvent(state, workEvent("wrong-version", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", "work-vertical-slice", revision, {
    result: "pass", completionEventId: "exact-completed", evidenceVersion: "newer456", summary: "Different version"
  })), /exact current completion/);
  assert.throws(() => applyEvent(state, workEvent("wrong-completion", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", "work-vertical-slice", revision, {
    result: "pass", completionEventId: "older-completed", evidenceVersion: "abc123", summary: "Different receipt"
  })), /exact current completion/);
});

test("verification failure blocks current work and preserves its receipt", () => {
  let state = completeBuild(baseState(), "abc123", "failed-completed");
  const revision = state.workItems["work-vertical-slice"].revision;
  state = applyEvent(state, workEvent("failed-verification", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", "work-vertical-slice", revision, {
    result: "fail",
    completionEventId: "failed-completed",
    evidenceVersion: "abc123",
    summary: "Mobile control is clipped",
    nextAction: "Codex fixes mobile layout"
  }));
  assert.equal(state.workItems["work-vertical-slice"].state, WORK_STATES.BLOCKED);
  assert.equal(state.workItems["work-vertical-slice"].receipt.evidenceVersion, "abc123");
  assert.match(state.workItems["work-vertical-slice"].blocker.reason, /clipped/);
});

test("a later PASS cannot clear an unresolved blocker", () => {
  let state = completeBuild(baseState(), "abc123", "blocked-completed");
  state = applyEvent(state, workEvent("blocked-fail", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", "work-vertical-slice", 4, {
    result: "fail", completionEventId: "blocked-completed", evidenceVersion: "abc123", summary: "Finding"
  }));
  state = applyEvent(state, workEvent("late-pass", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", "work-vertical-slice", 5, {
    result: "pass", completionEventId: "blocked-completed", evidenceVersion: "abc123", summary: "Retest passed"
  }));
  assert.equal(state.workItems["work-vertical-slice"].state, WORK_STATES.BLOCKED);
  assert.ok(state.workItems["work-vertical-slice"].blocker);
});

test("approval is rejected before required independent verification", () => {
  const state = completeBuild(baseState(), "abc123", "approval-completed");
  const revision = state.workItems["work-vertical-slice"].revision;
  assert.throws(() => applyEvent(state, ownerDecision("early-approval", "work-vertical-slice", revision, "approval-completed", "abc123", "approved")), /requires the designated independent PASS/);
});

test("only the designated human decision-maker records approval", () => {
  let state = verifiedBuild();
  const item = state.workItems["work-vertical-slice"];
  assert.throws(() => applyEvent(state, workEvent("maya-approval", EVENT_TYPES.OWNER_DECISION_RECORDED, "maya", item.id, item.revision, {
    decision: "approved", completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion, reason: "Ship it"
  })), /lacks decide/);
  state = applyEvent(state, ownerDecision("owner-approval", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved"));
  assert.equal(state.workItems[item.id].state, WORK_STATES.COMPLETED);
  assert.equal(state.workItems[item.id].decision.decision, "approved");
});

test("changes requested blocks the version and a replacement result drops old PASS and approval", () => {
  let state = verifiedBuild();
  let item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, ownerDecision("owner-changes", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "changes_requested"));
  item = state.workItems[item.id];
  assert.equal(item.state, WORK_STATES.BLOCKED);
  assert.equal(item.decision.decision, "changes_requested");

  state = applyEvent(state, workEvent("direction-accepted", EVENT_TYPES.WORK_BLOCKER_RESOLVED, "codex", item.id, item.revision, { resolution: "Direction accepted" }));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("revision-started", EVENT_TYPES.WORK_STARTED, "codex", item.id, item.revision));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("replacement-completed", EVENT_TYPES.WORK_COMPLETED, "codex", item.id, item.revision, {
    summary: "Revised result",
    evidenceUrl: "https://github.com/Uuriko/project-room/pull/3",
    evidenceVersion: "def456",
    nextAction: "Instinct checks the replacement"
  }));
  item = state.workItems[item.id];
  assert.equal(item.state, WORK_STATES.COMPLETED);
  assert.equal(item.receipt.evidenceVersion, "def456");
  assert.equal(item.verification, null);
  assert.equal(item.decision, null);
  assert.equal(item.verificationHistory.at(-1).evidenceVersion, "abc123");
  assert.equal(item.decisionHistory.at(-1).decision, "changes_requested");
});

test("approved completed work requires an explicit rework path before a replacement", () => {
  let state = verifiedBuild();
  let item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, ownerDecision("approved-v1", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved"));
  item = state.workItems[item.id];

  assert.throws(
    () => applyEvent(state, workEvent("silent-restart", EVENT_TYPES.WORK_STARTED, "codex", item.id, item.revision)),
    /Invalid transition from completed/
  );

  state = applyEvent(state, workEvent("rework-requested", EVENT_TYPES.WORK_BLOCKED, "codex", item.id, item.revision, {
    reason: "A voluntary v2 is now requested",
    nextAction: "Codex accepts the explicit v2 direction"
  }));
  item = state.workItems[item.id];
  assert.equal(item.decision, null);
  assert.equal(item.decisionHistory.length, 1);
  assert.equal(item.decisionHistory[0].decision, "approved");
  assert.equal(item.decisionHistory[0].historical, true);
  assert.equal(item.decisionHistory[0].invalidatedReason, "rework");
  state = applyEvent(state, workEvent("rework-accepted", EVENT_TYPES.WORK_BLOCKER_RESOLVED, "codex", item.id, item.revision, {
    resolution: "The v2 direction and scope are accepted"
  }));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("rework-started", EVENT_TYPES.WORK_STARTED, "codex", item.id, item.revision));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("completed-v2", EVENT_TYPES.WORK_COMPLETED, "codex", item.id, item.revision, {
    summary: "Voluntary replacement",
    evidenceUrl: "https://github.com/Uuriko/project-room/pull/3",
    evidenceVersion: "def456",
    nextAction: "Instinct verifies v2"
  }));

  item = state.workItems[item.id];
  assert.equal(item.state, WORK_STATES.COMPLETED);
  assert.equal(item.receipt.evidenceVersion, "def456");
  assert.equal(item.receiptHistory.at(-1).evidenceVersion, "abc123");
  assert.equal(item.verification, null);
  assert.equal(item.decision, null);
});

test("a current verification failure retires an earlier approval exactly once", () => {
  let state = verifiedBuild();
  let item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, ownerDecision("approved-before-fail", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved"));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("current-fail-after-approval", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", item.id, item.revision, {
    result: "fail",
    completionEventId: item.receipt.eventId,
    evidenceVersion: item.receipt.evidenceVersion,
    summary: "The current evidence no longer passes",
    nextAction: "Revise the current result"
  }));
  item = state.workItems[item.id];
  assert.equal(item.state, WORK_STATES.BLOCKED);
  assert.equal(item.verification.result, "fail");
  assert.equal(item.decision, null);
  assert.equal(item.decisionHistory.length, 1);
  assert.equal(item.decisionHistory[0].eventId, "approved-before-fail");
  assert.equal(item.decisionHistory[0].invalidatedByEventId, "current-fail-after-approval");
  assert.equal(item.decisionHistory[0].invalidatedReason, "verification_failed");
});

test("superseding approved work retires its approval", () => {
  let state = verifiedBuild();
  let item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, ownerDecision("approved-before-supersede", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved"));
  state = applyEvent(state, proposal("approved-replacement", "work-approved-replacement", "maya", "instinct", "read"));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("supersede-approved", EVENT_TYPES.WORK_SUPERSEDED, "potter", item.id, item.revision, {
    supersededByWorkItemId: "work-approved-replacement",
    reason: "Use the replacement"
  }));
  item = state.workItems[item.id];
  assert.equal(item.state, WORK_STATES.SUPERSEDED);
  assert.equal(item.decision, null);
  assert.equal(item.decisionHistory.length, 1);
  assert.equal(item.decisionHistory[0].invalidatedReason, "superseded");
});

test("late evidence for a known older version is historical and cannot affect the current version", () => {
  let state = verifiedBuild();
  let item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, ownerDecision("approved-old", item.id, item.revision, item.receipt.eventId, item.receipt.evidenceVersion, "approved"));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("old-rework-requested", EVENT_TYPES.WORK_BLOCKED, "codex", item.id, item.revision, {
    reason: "Prepare v2",
    nextAction: "Accept v2"
  }));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("old-rework-resolved", EVENT_TYPES.WORK_BLOCKER_RESOLVED, "codex", item.id, item.revision, {
    resolution: "v2 accepted"
  }));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("old-rework-started", EVENT_TYPES.WORK_STARTED, "codex", item.id, item.revision));
  item = state.workItems[item.id];
  state = applyEvent(state, workEvent("current-completed", EVENT_TYPES.WORK_COMPLETED, "codex", item.id, item.revision, {
    summary: "Current v2",
    evidenceUrl: "https://github.com/Uuriko/project-room/pull/3",
    evidenceVersion: "def456",
    nextAction: "Verify v2"
  }));
  item = state.workItems[item.id];

  state = applyEvent(state, workEvent("late-old-fail", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", item.id, item.revision, {
    result: "fail",
    completionEventId: "verified-completed",
    evidenceVersion: "abc123",
    summary: "Late finding on v1"
  }));

  item = state.workItems[item.id];
  assert.equal(item.state, WORK_STATES.COMPLETED);
  assert.equal(item.receipt.evidenceVersion, "def456");
  assert.equal(item.verification, null);
  assert.equal(item.decision, null);
  assert.equal(item.blocker, null);
  assert.equal(item.verificationHistory.at(-1).eventId, "late-old-fail");
  assert.equal(item.verificationHistory.at(-1).historical, true);
});

test("independent work cannot assign the accountable member as verifier", () => {
  const state = baseState();
  assert.throws(() => applyEvent(state, proposal("same-verifier", "work-self-verify", "codex", "codex", "read")), /different accountable member and verifier/);
});

test("supersession rejects self-links and cycles and retires an active claim", () => {
  let state = baseState();
  state = applyEvent(state, proposal("supersede-source", "work-supersede-source", "codex", "instinct", "write"));
  state = applyEvent(state, workEvent("supersede-accepted", EVENT_TYPES.WORK_ACCEPTED, "codex", "work-supersede-source", 0));
  state = applyEvent(state, workEvent("supersede-claim", EVENT_TYPES.CLAIM_ACQUIRED, "codex", "work-supersede-source", 1, {
    repository: "Uuriko/project-room",
    ref: "codex/supersede-source",
    paths: ["src/events.js"],
    expiresAt: "2026-09-06T10:00:00.000Z"
  }));
  state = applyEvent(state, proposal("supersede-replacement", "work-supersede-replacement", "maya", "instinct", "read"));

  assert.throws(() => applyEvent(state, workEvent("self-supersede", EVENT_TYPES.WORK_SUPERSEDED, "potter", "work-supersede-source", 2, {
    supersededByWorkItemId: "work-supersede-source",
    reason: "invalid self replacement"
  })), /cannot supersede itself/);

  state = applyEvent(state, workEvent("valid-supersede", EVENT_TYPES.WORK_SUPERSEDED, "potter", "work-supersede-source", 2, {
    supersededByWorkItemId: "work-supersede-replacement",
    reason: "replacement outcome"
  }));
  const source = state.workItems["work-supersede-source"];
  assert.equal(source.state, WORK_STATES.SUPERSEDED);
  assert.equal(source.claim.status, "superseded");
  assert.equal(source.claim.supersededAt, "2026-09-05T10:00:00.000Z");

  assert.throws(() => applyEvent(state, workEvent("cyclic-supersede", EVENT_TYPES.WORK_SUPERSEDED, "potter", "work-supersede-replacement", 0, {
    supersededByWorkItemId: "work-supersede-source",
    reason: "invalid cycle"
  })), /must not already be superseded/);
});

test("event helper creates the required Room-scoped envelope", () => {
  const created = event({ roomId: ROOM_ID, type: EVENT_TYPES.MESSAGE_POSTED, actorId: "potter", data: { body: "hello" } });
  assert.ok(created.id);
  assert.ok(created.idempotencyKey);
  assert.equal(created.roomId, ROOM_ID);
});

function proposal(id, workItemId, accountableMemberId, verifierMemberId, mode) {
  return fixedEvent(id, EVENT_TYPES.WORK_PROPOSED, "potter", {
    workItemId,
    title: `Work ${workItemId}`,
    definitionOfDone: "Exact evidence is returned",
    accountableMemberId,
    verifierMemberId,
    independentVerificationRequired: true,
    ownerDecisionRequired: true,
    humanDecisionMakerId: "potter",
    mode
  });
}

function completeBuild(state, evidenceVersion, completionEventId, extra = {}) {
  const item = state.workItems["work-vertical-slice"];
  return applyEvent(state, workEvent(completionEventId, EVENT_TYPES.WORK_COMPLETED, "codex", item.id, item.revision, {
    summary: "Prototype complete",
    evidenceUrl: "https://github.com/Uuriko/project-room/pull/3",
    evidenceVersion,
    nextAction: "Instinct verifies",
    producerId: "codex",
    ...extra
  }));
}

function verifiedBuild() {
  let state = completeBuild(baseState(), "abc123", "verified-completed");
  const item = state.workItems["work-vertical-slice"];
  state = applyEvent(state, workEvent("verified-pass", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", item.id, item.revision, {
    result: "pass",
    completionEventId: item.receipt.eventId,
    evidenceVersion: item.receipt.evidenceVersion,
    summary: "Exact version passes"
  }));
  return state;
}

function ownerDecision(id, workItemId, expectedRevision, completionEventId, evidenceVersion, decision) {
  return workEvent(id, EVENT_TYPES.OWNER_DECISION_RECORDED, "potter", workItemId, expectedRevision, {
    decision,
    completionEventId,
    evidenceVersion,
    reason: decision === "approved" ? "Verified result accepted" : "Revise the current result"
  });
}

function workEvent(id, type, actorId, workItemId, expectedRevision, extra = {}) {
  return fixedEvent(id, type, actorId, { workItemId, expectedRevision, ...extra });
}

function fixedEvent(id, type, actorId, data) {
  return {
    id,
    idempotencyKey: `key-${id}`,
    roomId: ROOM_ID,
    type,
    actorId,
    at: "2026-09-05T10:00:00.000Z",
    causationId: null,
    data
  };
}
