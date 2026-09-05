import { EVENT_TYPES } from "./events.js";

const ROOM_ID = "room-project-room-v0";
const at = (minute) => `2026-09-05T09:${String(minute).padStart(2, "0")}:00.000Z`;
const e = (id, type, actorId, minute, data, causationId = null) => ({
  id,
  idempotencyKey: `seed-${id}`,
  roomId: ROOM_ID,
  type,
  actorId,
  at: at(minute),
  causationId,
  data
});

export const seedEvents = [
  e("evt-room", EVENT_TYPES.ROOM_CREATED, "potter", 0, {
    roomId: ROOM_ID,
    title: "Ship Project Room v0",
    purpose: "Replace manual context routing with one accountable, source-backed record.",
    ownerId: "potter"
  }),
  e("evt-member-potter", EVENT_TYPES.MEMBER_ADDED, "potter", 1, {
    memberId: "potter",
    displayName: "Potter",
    kind: "human",
    permissions: ["steer", "decide", "manage_members", "manage_claims"]
  }, "evt-room"),
  e("evt-member-codex", EVENT_TYPES.MEMBER_ADDED, "potter", 2, {
    memberId: "codex",
    displayName: "Codex",
    kind: "agent",
    permissions: ["accept_work", "complete_work", "write_external"]
  }, "evt-member-potter"),
  e("evt-member-instinct", EVENT_TYPES.MEMBER_ADDED, "potter", 3, {
    memberId: "instinct",
    displayName: "Instinct",
    kind: "agent",
    permissions: ["accept_work", "complete_work", "verify"]
  }, "evt-member-codex"),
  e("evt-member-maya", EVENT_TYPES.MEMBER_ADDED, "potter", 4, {
    memberId: "maya",
    displayName: "Maya",
    kind: "human",
    permissions: ["steer"]
  }, "evt-member-instinct"),
  e("evt-message-1", EVENT_TYPES.MESSAGE_POSTED, "potter", 5, {
    body: "Build the smallest useful room where I can see what was asked, who owns it, the evidence, and what needs me next."
  }),
  e("evt-work-review", EVENT_TYPES.WORK_PROPOSED, "potter", 6, {
    workItemId: "work-spec-review",
    title: "Review the Project Room v0 contract",
    definitionOfDone: "Exact spec revision is checked independently and any contradiction is source-linked.",
    accountableMemberId: "codex",
    verifierMemberId: "instinct",
    independentVerificationRequired: true,
    ownerDecisionRequired: true,
    humanDecisionMakerId: "potter",
    mode: "read"
  }, "evt-message-1"),
  e("evt-work-review-accepted", EVENT_TYPES.WORK_ACCEPTED, "codex", 7, {
    workItemId: "work-spec-review",
    expectedRevision: 0
  }, "evt-work-review"),
  e("evt-work-review-started", EVENT_TYPES.WORK_STARTED, "codex", 8, {
    workItemId: "work-spec-review",
    expectedRevision: 1
  }, "evt-work-review-accepted"),
  e("evt-message-2", EVENT_TYPES.MESSAGE_POSTED, "codex", 9, {
    body: "I found the existing spec work and am reviewing that exact revision instead of creating a duplicate.",
    workItemId: "work-spec-review"
  }, "evt-work-review-started"),
  e("evt-work-review-completed", EVENT_TYPES.WORK_COMPLETED, "codex", 10, {
    workItemId: "work-spec-review",
    expectedRevision: 2,
    summary: "The core work-item model is sound; four consistency corrections are required before implementation.",
    evidenceUrl: "https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5550878240",
    evidenceVersion: "58875941ed50d01edacbdc91f1edebe85ba6b53e",
    checksClaimed: ["object model", "authority boundaries", "failure recovery"],
    nextAction: "Instinct checks the same revision"
  }, "evt-work-review-started"),
  e("evt-work-review-verified", EVENT_TYPES.VERIFICATION_RECORDED, "instinct", 30, {
    workItemId: "work-spec-review",
    expectedRevision: 3,
    result: "pass",
    completionEventId: "evt-work-review-completed",
    evidenceVersion: "58875941ed50d01edacbdc91f1edebe85ba6b53e",
    summary: "Pressure-test reconstructed the active state and confirmed the strongest contradictions."
  }, "evt-work-review-completed"),
  e("evt-message-3", EVENT_TYPES.MESSAGE_POSTED, "instinct", 31, {
    body: "Verified the exact spec revision. Completion and independent verification remain separate; no manual context paste was needed.",
    workItemId: "work-spec-review"
  }, "evt-work-review-verified"),
  e("evt-work-build", EVENT_TYPES.WORK_PROPOSED, "potter", 32, {
    workItemId: "work-vertical-slice",
    title: "Build the first executable Room slice",
    definitionOfDone: "A browser prototype replays the accountable work loop, rejects invalid transitions, persists locally, and passes automated tests.",
    accountableMemberId: "codex",
    verifierMemberId: "instinct",
    independentVerificationRequired: true,
    ownerDecisionRequired: true,
    humanDecisionMakerId: "potter",
    mode: "write"
  }, "evt-work-review-verified"),
  e("evt-work-build-accepted", EVENT_TYPES.WORK_ACCEPTED, "codex", 33, {
    workItemId: "work-vertical-slice",
    expectedRevision: 0
  }, "evt-work-build"),
  e("evt-work-build-claim", EVENT_TYPES.CLAIM_ACQUIRED, "codex", 34, {
    workItemId: "work-vertical-slice",
    expectedRevision: 1,
    repository: "Uuriko/project-room",
    ref: "codex/project-room-v0-vertical-slice-20260905",
    paths: ["index.html", "src/**", "tests/**", "package.json", "server.mjs"],
    expiresAt: "2026-09-06T09:34:00.000Z"
  }, "evt-work-build-accepted"),
  e("evt-work-build-started", EVENT_TYPES.WORK_STARTED, "codex", 35, {
    workItemId: "work-vertical-slice",
    expectedRevision: 2
  }, "evt-work-build-claim"),
  e("evt-message-4", EVENT_TYPES.MESSAGE_POSTED, "codex", 36, {
    body: "Implementation is in progress on a dedicated branch. The spec branch and its active documentation edit remain untouched.",
    workItemId: "work-vertical-slice"
  }, "evt-work-build-started")
];
