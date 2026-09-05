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
  const state = completeBuild(baseState(), "abc123", "build-completed");
  const item = state.workItems["work-vertical-slice"];
  assert.equal(item.state, WORK_STATES.COMPLETED);
  assert.equal(item.verification, null);
  assert.equal(item.receipt.evidenceVersion, "abc123");
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
  assert.equal(state.workItems["work-vertical-slice"].state, WORK_STATES.COMPLETED);
  assert.equal(state.workItems["work-vertical-slice"].verification.result, "pass");
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

function completeBuild(state, evidenceVersion, completionEventId) {
  const item = state.workItems["work-vertical-slice"];
  return applyEvent(state, workEvent(completionEventId, EVENT_TYPES.WORK_COMPLETED, "codex", item.id, item.revision, {
    summary: "Prototype complete",
    evidenceUrl: "https://github.com/Uuriko/project-room/pull/3",
    evidenceVersion,
    nextAction: "Instinct verifies"
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
