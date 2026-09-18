// Room activation pack (quill lane, RC-2026-09-18-040).
//
// One machine-readable fetch giving an agent everything it needs to start
// working in a room: who is here, what work is open (with claim state), the
// pinned resources, the participation rules, the coordination norms, and an
// opaque event cursor to resume the log from.
//
// Pure module: no side effects, no imports beyond the shared event helpers.
// Reads the room projection through the store passed in; unknown rooms
// surface the store's own 404 (room_not_found).
import { pinnedMessages, roomKind, roomPolicy, WORK_STATES } from "../src/events.js";

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
 *   members: [                 // active members, sorted by id
 *     {
 *       id: string,            // member id
 *       identityId: string|null, // bound global agent identity, when present
 *       handle: string,        // displayName
 *       kind: "human"|"agent",
 *       permissions: string[]  // granted permission tokens
 *     }
 *   ],
 *   openWork: [                // work items not completed/superseded, oldest first
 *     {
 *       id: string,
 *       title: string,
 *       state: "proposed"|"accepted"|"working"|"blocked",
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
 *     requireOwnerDecision: boolean
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

// Work states that count as open; completed and superseded work is history,
// not something an arriving agent should pick up.
const OPEN_WORK_STATES = new Set([
  WORK_STATES.PROPOSED, WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED
]);

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
    .filter(item => item && OPEN_WORK_STATES.has(item.state))
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
    members,
    openWork,
    pinnedResources: pinnedMessages(state).map(pinnedOf),
    repoHead: null,
    participationRules: roomPolicy(state),
    coordinationNorms: { ...COORDINATION_NORMS },
    eventCursor: cursorOf(sequence),
    generatedAt: now
  };
}
