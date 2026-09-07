export const ROOM_ID = "room-project-room-v0";
export const WORK_ITEM_ID = "work-134-review";
export const ARTIFACT_SHA = "70053cc6cf9d86f3a43220dcfbb0af05797380c0";
export const EVIDENCE_URL = "https://github.com/Uuriko/dasha-desk/pull/134";

const at = (minute) => `2026-09-05T09:${String(minute).padStart(2, "0")}:00.000Z`;

export function event(id, type, actorId, minute, data, extras = {}) {
  return {
    id,
    idempotencyKey: `fix-${id}`,
    roomId: ROOM_ID,
    type,
    actorId,
    at: at(minute),
    causationId: extras.causationId ?? null,
    data,
    ...extras
  };
}

export function proposeReview(minute = 10) {
  return event("evt-work-134", "work.proposed", "potter", minute, {
    workItemId: WORK_ITEM_ID,
    title: "Review whether PR #134 is ready",
    definitionOfDone: "Exact revision is independently checked; owner decision remains explicit.",
    accountableMemberId: "codex",
    verifierMemberId: "instinct",
    independentVerificationRequired: true,
    ownerDecisionRequired: true,
    humanDecisionMakerId: "potter",
    mode: "read"
  });
}

export function completeKnownProducer({
  id = "evt-work-134-completed",
  actorId = "codex",
  producerId = "codex",
  minute = 14,
  expectedRevision = 2
} = {}) {
  return event(id, "work.completed", actorId, minute, {
    workItemId: WORK_ITEM_ID,
    expectedRevision,
    summary: "Existing change at the recorded revision; no replacement patch.",
    evidenceUrl: EVIDENCE_URL,
    evidenceVersion: ARTIFACT_SHA,
    producerId,
    checksClaimed: ["object model", "authority boundaries"],
    nextAction: "Instinct checks the same revision"
  });
}

export function completeUnknownProducer({
  id = "evt-work-134-completed",
  actorId = "codex",
  minute = 14
} = {}) {
  return event(id, "work.completed", actorId, minute, {
    workItemId: WORK_ITEM_ID,
    expectedRevision: 2,
    summary: "Existing change found; producer attribution unknown.",
    evidenceUrl: EVIDENCE_URL,
    evidenceVersion: ARTIFACT_SHA,
    producerAttribution: "unknown",
    checksClaimed: ["object model"],
    nextAction: "Instinct checks the same revision"
  });
}

export function verifyPass({
  id = "evt-work-134-verified",
  actorId = "instinct",
  minute = 30,
  extras = {}
} = {}) {
  return event(
    id,
    "verification.recorded",
    actorId,
    minute,
    {
      workItemId: WORK_ITEM_ID,
      expectedRevision: 3,
      result: "pass",
      completionEventId: "evt-work-134-completed",
      evidenceVersion: ARTIFACT_SHA,
      summary: "Independent PASS on the exact recorded revision."
    },
    extras
  );
}

export function ownerDecision({
  id = "evt-work-134-decided",
  actorId = "potter",
  minute = 40,
  extras = {}
} = {}) {
  return event(
    id,
    "owner.decision_recorded",
    actorId,
    minute,
    {
      workItemId: WORK_ITEM_ID,
      expectedRevision: 4,
      decision: "approved",
      completionEventId: "evt-work-134-completed",
      evidenceVersion: ARTIFACT_SHA,
      reason: "Owner decision recorded on the verified revision. Merge remains a separate external action."
    },
    extras
  );
}

export function chatter() {
  return [
    event("evt-msg-1", "message.posted", "potter", 5, {
      body: "Is the linked #134 change ready for review?"
    }),
    event("evt-msg-2", "message.posted", "codex", 13, {
      body: "Found the existing result at 70053cc6cf9d86f3a43220dcfbb0af05797380c0.",
      workItemId: WORK_ITEM_ID
    }),
    event("evt-msg-ack", "message.reaction_set", "maya", 15, {
      messageId: "evt-msg-2",
      reaction: "ack",
      active: true
    }),
    event("evt-msg-3", "message.posted", "instinct", 31, {
      body: "Checked the exact revision. No recap paste required.",
      workItemId: WORK_ITEM_ID
    })
  ];
}
