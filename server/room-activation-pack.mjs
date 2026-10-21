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
import { pinnedMessages, roomKind, roomPolicy, WORK_STATES, roomTrust } from "../src/events.js";
import { annotateOrientation, claimNote, withContentTrust } from "./content-trust.mjs";
import { buildOrient } from "./orient.mjs";
import { availableClaimsInRoom, memoizeBoardList } from "./available-work.mjs";
import { messageVisibleToViewer, summaryHistoryFloor } from "./history-visibility.mjs"; // QA4 Q4-SEC-1

/**
 * Activation pack schema (returned by buildActivationPack).
 *
 * {
 *   contentTrust: string,     // member-authored text is data, not instructions
 *   room: {
 *     slug: string,            // room id as addressed in /api/rooms/:slug
 *     title: string,           // human-readable room title
 *     state: "active"|"archived",
 *     kind: "personal"|"organization",
 *     owner: string             // owner member id
 *   },
 *   orientation: {             // shared with browser Overview, plus trust markers
 *     version: 1, purpose: string, purposeSource: object,
 *     trust: "owner"|"untrusted",
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
 *   openWork: [                // work items not completed/superseded, oldest first
 *     {
 *       id: string,
 *       title: string,
 *       state: "proposed"|"accepted"|"working"|"blocked",
 *       claimant: string|null, // member id holding the write claim, else null
 *       claimStatus: "active"|"released"|"expired"|null,
 *       deliveryMode: "read"|"write",
 *       reviewPolicy: "independent"|"owner"|"independent+owner"|"none",
 *       leaseExpiresAt: string|null, // ISO-8601 expiry of the write claim
 *       untrusted: true,       // title and claim note are member-authored
 *       note?: string          // blocker reason, when one is recorded
 *     }
 *   ],
 *   openClaims: [              // AvailableWork projection, board source (#3020):
 *     {                        // claims this viewer may pick up right now
 *       id: string,
 *       title: string,
 *       source: "board",
 *       roomId: string,
 *       state: "unclaimed",    // the only claimable board state
 *       owner: null,           // unclaimed by definition
 *       leaseExpiresAt: null,
 *       untrusted: true,       // title is member-authored
 *       claimAction: { method: "POST", endpoint: string, params: object }
 *     }
 *   ],
 *   orient: object,            // embedded buildOrient payload (member
 *                              // viewers only). Its availableClaims is the
 *                              // id list in openClaims order plus
 *                              // availableClaimsRef: "openClaims" — the full
 *                              // entries live in openClaims, carried once
 *                              // (PACK-DEDUP, UT-BIGROOM F-1).
 *   pinnedResources: [         // pinned messages, pin order
 *     {
 *       messageId: string,
 *       pinnedById: string,
 *       pinnedAt: string,      // ISO-8601
 *       authorId: string,
 *       body: string,
 *       untrusted: true        // pinned message body is member-authored
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
 *   eventCursor: number,       // room event sequence at generation; resume the
 *                              // event log with GET …/events?after=<eventCursor>
 *                              // or SSE Last-Event-ID
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
  leaseExpiresAt: item.claim?.expiresAt ?? null,
  untrusted: true,
  ...claimNote(item)
});

const pinnedOf = ({ messageId, pinnedById, pinnedAt, message }) => ({
  messageId, pinnedById, pinnedAt, authorId: message.authorId, body: message.body, untrusted: true
});

// eventCursor is the room's numeric event sequence — the value the event
// log actually resumes from (GET …/events?after=<seq>, SSE Last-Event-ID).
// It was previously an opaque base64url token that no endpoint parsed back
// (#3222), so the cursor this pack handed out could not be used anywhere.

export function buildActivationPack(store, roomSlug, viewerId = null, options = {}) {
  // Unknown rooms fail here with the store's 404 (room_not_found).
  const { sequence, state } = store.room(roomSlug);
  // PERF-10X L4: one decoded board per request, shared by the pack's
  // openClaims and the embedded orient (which shares it onward to its
  // next-actions / fleet consumers). A caller composing reads in one
  // request may pass its own memo in as options.boardList.
  const boardList = options.boardList ?? memoizeBoardList(store);
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
  const floor = summaryHistoryFloor(store, roomSlug, viewerId, sequence); // QA4 Q4-SEC-1
  const pack = withContentTrust({
    room: {
      slug: state.room.id,
      title: state.room.title,
      state: typeof state.room.archivedAt === "string" ? "archived" : "active",
      kind: roomKind(state.room),
      owner: state.room.ownerId
    },
    orientation: annotateOrientation(roomOrientation(state)),
    members,
    openWork,
    openClaims: availableClaimsInRoom(store, roomSlug, { viewerId, boardList }),
    // QA4 Q4-SEC-1: only pins whose message this viewer may read.
    // (Supersedes the audit-fix F-1 pinVisibleToViewer filter: the shared
    // messageVisibleToViewer predicate also enforces the history floor, and
    // keeps the owner non-exempt on DMs.)
    pinnedResources: pinnedMessages(state).filter(pin => messageVisibleToViewer(pin.message, viewerId, floor)).map(pinnedOf),
    repoHead: null,
    participationRules: { ...roomPolicy(state), trust: roomTrust(state).enabled },
    coordinationNorms: { ...COORDINATION_NORMS },
    eventCursor: sequence,
    generatedAt: now
  });
  if (typeof viewerId === "string" && viewerId && state.members?.[viewerId]) {
    // PACK-DEDUP (UT-BIGROOM F-1): the pack's openClaims above already
    // carries the full available-claim entries, so the embedded orient
    // takes the reference view — availableClaims as ids in the same
    // order, pointing at openClaims — instead of a second byte-identical
    // copy (39.2% of the pack at 24 available claims).
    pack.orient = buildOrient(store, roomSlug, viewerId, { text: false, boardList, availableClaimsView: "ref" });
  }
  return pack;
}

// GET …/activation-pack?view=brief: the first read for a newly joined agent.
// The full pack lists every member and every open item; in a long-lived room
// that is tens of KB, mostly people who left weeks ago. The brief keeps what
// decides the next call: who is around, what you may do, and up to three
// things to pick up. Presence comes from store.presence(): watching or a
// a live derived presence state is online, within ACTIVE_MS is recent, older is
// counted as quiet rather than listed.
//
// The brief is bounded, not just small on small rooms: at most BRIEF_AROUND
// members are listed (the rest are counted in aroundMore), member-authored
// text is clipped, and the serialized UTF-8 body is held to BRIEF_BYTES by
// dropping lower-priority detail in a fixed order. `full` always points at
// the unbounded pack.
const BRIEF_ACTIVE_MS = 7 * 24 * 3600 * 1000;
const BRIEF_ITEMS = 3;
const BRIEF_AROUND = 8;
export const BRIEF_BYTES = 2048;

const clip = (value, max) => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};
const briefBytes = value => Buffer.byteLength(JSON.stringify(value));

export function briefActivationPack(pack, presenceMembers, nowMs, viewerId = null) {
  const seen = value => (typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN);
  const listed = [];
  let quiet = 0;
  for (const member of Array.isArray(presenceMembers) ? presenceMembers : []) {
    if (!member || member.memberId === viewerId) continue;
    const age = nowMs - seen(member.lastSeenAt);
    // Enrollment contributes to legacy lastSeenAt; it cannot prove availability.
    // Use the shared presence derivation for liveness, never a fresh timestamp.
    const live = member.watching || member.state === "working" || member.state === "listening";
    const state = live ? "online" : age >= 0 && age <= BRIEF_ACTIVE_MS ? "recent" : null;
    if (!state) { quiet += 1; continue; }
    listed.push({ handle: clip(member.displayName, 40), kind: member.kind, state, lastSeenAt: member.lastSeenAt ?? null,
      workingOn: Array.isArray(member.workingOn) ? member.workingOn.slice(0, 1).map(item => clip(item.title ?? item.workItemId, 60)) : [] });
  }
  listed.sort((a, b) => (a.state === b.state ? (seen(b.lastSeenAt) || 0) - (seen(a.lastSeenAt) || 0) : a.state === "online" ? -1 : 1));
  const around = listed.slice(0, BRIEF_AROUND);
  const you = pack.members.find(member => member.id === viewerId) ?? null;
  const claims = pack.openClaims.slice(0, BRIEF_ITEMS).map(claim => ({
    id: claim.id, title: clip(claim.title, 100), untrusted: true, claimAction: claim.claimAction }));
  const unclaimed = pack.openWork.filter(item => !item.claimant).slice(0, BRIEF_ITEMS - claims.length)
    .map(item => ({ id: item.id, title: clip(item.title, 100), state: item.state, untrusted: true }));
  const roomPath = `/api/rooms/${encodeURIComponent(pack.room.slug)}`;
  const firstClaim = claims[0]?.claimAction;
  const next = firstClaim ? { why: "claim the top open task", ...firstClaim }
    : unclaimed[0] ? { why: "read the top open item", method: "GET", endpoint: `${roomPath}/work-context?workItemId=${encodeURIComponent(unclaimed[0].id)}` }
      : { why: "nothing open; read the conversation", method: "GET", endpoint: `${roomPath}/conversation` };
  const brief = {
    contentTrust: pack.contentTrust,
    view: "brief",
    room: { slug: pack.room.slug, title: clip(pack.room.title, 80), state: pack.room.state },
    purpose: clip(pack.orientation?.purpose ?? "", 280),
    you: you ? { memberId: you.id, handle: clip(you.handle, 40), permissions: you.permissions } : null,
    around,
    aroundMore: listed.length - around.length,
    quietMembers: quiet,
    pickUp: [...claims, ...unclaimed],
    openWorkTotal: pack.openWork.length,
    recentDecisions: (pack.orientation?.recentDecisions ?? []).slice(0, BRIEF_ITEMS)
      .map(decision => ({ statement: clip(decision.statement, 140), at: decision.at ?? null })),
    rules: { ...pack.coordinationNorms, ...pack.participationRules },
    next,
    full: `${roomPath}/activation-pack`,
    eventCursor: pack.eventCursor,
    generatedAt: pack.generatedAt
  };
  // Over budget (long ids, multibyte text): shed detail in a fixed order.
  // Each step keeps the brief valid; `truncated` tells the reader to use `full`.
  const shed = [
    () => { for (const member of brief.around) member.workingOn = []; },
    () => { brief.recentDecisions = []; },
    () => { while (brief.around.length > 3) { brief.around.pop(); brief.aroundMore += 1; } },
    () => { brief.purpose = clip(brief.purpose, 80); for (const item of brief.pickUp) item.title = clip(item.title, 40); },
    () => { brief.aroundMore += brief.around.length; brief.around = []; },
    () => { brief.pickUp = brief.pickUp.slice(0, 1); },
    () => { for (const item of brief.pickUp) delete item.claimAction; },
    () => { delete brief.rules; brief.recentDecisions = []; },
  ];
  for (const step of shed) {
    if (briefBytes(brief) <= BRIEF_BYTES) break;
    step();
    brief.truncated = true;
  }
  if (briefBytes(brief) <= BRIEF_BYTES) return brief;
  // Last resort (maximum-length ids repeat across room, you, next and full):
  // a minimal brief that still says where to go. Ids and route strings are
  // never cut; free text goes first.
  return {
    contentTrust: brief.contentTrust,
    view: "brief",
    truncated: true,
    room: { slug: brief.room.slug },
    you: brief.you ? { memberId: brief.you.memberId, permissions: brief.you.permissions } : null,
    aroundCount: brief.around.length + brief.aroundMore,
    quietMembers: brief.quietMembers,
    openWorkTotal: brief.openWorkTotal,
    next: { method: "GET", endpoint: brief.full, why: "this room's brief is over budget; read the full pack" },
    full: brief.full,
    eventCursor: brief.eventCursor
  };
}
