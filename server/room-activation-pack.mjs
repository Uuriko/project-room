// Room activation pack (quill lane, RC-2026-09-18-040).
//
// One machine-readable fetch giving an agent everything it needs to start
// working in a room: who is here, what work is open (with claim state), the
// pinned resources, the participation rules, the coordination norms, and an
// opaque event cursor to resume the log from.
//
// Read-only projection using shared event helpers and orientation selectors.
// Reads the room projection through the store passed in; unknown rooms
// surface the store's own 404 (room_not_found).
import { roomOrientation } from "../src/work-selectors.js";
import { workProgress } from "../src/work-packet.js";
import { pinnedMessages, roomKind, roomPolicy, roomTrust } from "../src/events.js";
import { terminalWork, nextWorkStep } from "../src/workflow.js";

/**
 * Activation pack schema (returned by buildActivationPack).
 *
 * {
 *   room: {
 *     slug: string,            // room id as addressed in /api/rooms/:slug
 *     title: string,           // human-readable room title
 *     state: "active"|"archived",
 *     kind: "personal"|"organization",
 *     owner: string             // owner member id
 *   },
 *   orientation: {             // shared with browser Overview
 *     version: 1, purpose: string, purposeSource: object,
 *     activeWork: object[], activeWorkTotal: number, recentDecisions: object[]
 *   },
 *   members: [                 // active members, sorted by id
 *     {
 *       id: string,            // member id
 *       identityId: string|null, // bound global agent identity, when present
 *       handle: string,        // displayName
 *       kind: "human"|"agent",
 *       permissions: string[]  // granted permission tokens
 *     }
 *   ],
 *   openWork: [                // nonterminal work, including pending review, oldest first
 *     {
 *       id: string,
 *       title: string,
 *       state: "proposed"|"accepted"|"working"|"blocked"|"completed",
 *       claimant: string|null, // member id holding the write claim, else null
 *       claimStatus: "active"|"released"|"expired"|null,
 *       deliveryMode: "read"|"write",
 *       reviewPolicy: "independent"|"owner"|"independent+owner"|"none",
 *       leaseExpiresAt: string|null // ISO-8601 expiry of the write claim
 *     }
 *   ],
 *   pinnedResources: [         // pinned messages, pin order
 *     {
 *       messageId: string,
 *       pinnedById: string,
 *       pinnedAt: string,      // ISO-8601
 *       authorId: string,
 *       body: string
 *     }
 *   ],
 *   repoHead: null,            // rooms record no repository head; per-work
 *                             // write claims carry repository/ref instead
 *   participationRules: {      // owner-set room policy, off by default
 *     requireIndependentReview: boolean,
 *     requireOwnerDecision: boolean,
 *     trust: boolean           // Room Trust. true (open) until the owner flips it off
 *   },
 *   coordinationNorms: {       // room-wide defaults; an agent honours these
 *     maxClaimsPerAgentPerCycle: number, // 1: one write claim per agent at a time
 *     releaseOnInactivityHours: number,  // 24: release claims idle this long
 *     stopAfterRepeatedNoopWakes: boolean // true: stand down after repeated
 *                                        // wakes that produce no action
 *   },
 *   eventCursor: string,       // opaque base64url resume token for the event log
 *   generatedAt: string        // ISO-8601 generation time
 * }
 */

// A submitted result with an outstanding review/decision is still open work.
// Use the same exact-result terminality as the browser rather than state alone.

// Coordination norms: the room's standing defaults. Frozen so callers cannot
// mutate the shared reference; buildActivationPack copies them per pack.
export const COORDINATION_NORMS = Object.freeze({
  maxClaimsPerAgentPerCycle: 1,
  releaseOnInactivityHours: 24,
  stopAfterRepeatedNoopWakes: true
});

const claimStatusOf = (claim, nowIso) => {
  if (!claim) return null;
  if (claim.status === "released") return "released";
  return Date.parse(claim.expiresAt) > Date.parse(nowIso) ? "active" : "expired";
};

const reviewPolicyOf = item => {
  if (item.independentVerificationRequired && item.ownerDecisionRequired) return "independent+owner";
  if (item.independentVerificationRequired) return "independent";
  if (item.ownerDecisionRequired) return "owner";
  return "none";
};

const memberOf = member => ({
  id: member.id,
  identityId: member.identityId ?? null,
  handle: member.displayName,
  kind: member.kind,
  permissions: [...member.permissions]
});

const workOf = (item, nowIso) => ({
  id: item.id,
  title: item.title,
  state: item.state,
  accountableMemberId: item.accountableMemberId,
  definitionOfDone: item.definitionOfDone,
  progress: workProgress(item, Date.parse(nowIso)),
  next: nextWorkStep(item, Date.parse(nowIso)),
  readContext: { tool: "room_read_work", arguments: { workItemId: item.id, includeDiscussion: true, includeSource: true } },
  claimant: item.claim?.holderId ?? null,
  claimStatus: claimStatusOf(item.claim, nowIso),
  deliveryMode: item.mode,
  reviewPolicy: reviewPolicyOf(item),
  leaseExpiresAt: item.claim?.expiresAt ?? null
});

const pinnedOf = ({ messageId, pinnedById, pinnedAt, message }) => ({
  messageId, pinnedById, pinnedAt, authorId: message.authorId, body: message.body
});

// Opaque resume token for the event log: versioned, self-describing to the
// server, meaningless to clients. Encodes the room event sequence the pack
// was generated from.
const cursorOf = sequence =>
  Buffer.from(JSON.stringify({ v: 1, seq: sequence }), "utf8").toString("base64url");

export function buildActivationPack(store, roomSlug) {
  // Unknown rooms fail here with the store's 404 (room_not_found).
  const { sequence, state } = store.room(roomSlug);
  if (!state.room) throw new Error("Room projection is missing its room record");
  const now = new Date(store.now()).toISOString();
  const members = Object.values(state.members ?? {})
    .filter(member => member?.active !== false)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(memberOf);
  const openWork = Object.values(state.workItems ?? {})
    .filter(item => item && !terminalWork(item))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map(item => workOf(item, now));
  return {
    room: {
      slug: state.room.id,
      title: state.room.title,
      state: typeof state.room.archivedAt === "string" ? "archived" : "active",
      kind: roomKind(state.room),
      owner: state.room.ownerId
    },
    orientation: roomOrientation(state),
    members,
    openWork,
    pinnedResources: pinnedMessages(state).map(pinnedOf),
    repoHead: null,
    participationRules: { ...roomPolicy(state), trust: roomTrust(state).enabled },
    coordinationNorms: { ...COORDINATION_NORMS },
    eventCursor: cursorOf(sequence),
    generatedAt: now
  };
}
