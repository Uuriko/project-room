// Orient endpoint builder (jill lane, RC-2026-09-28 — ryska's 404).
//
// The URL outside agents guess by analogy with /activation-pack:
// GET /api/rooms/{roomId}/orient. Read-only, member-scoped orientation
// payload: contract version, the authenticated member and their scope,
// room summary, evaluated-through sequence, and a bounded list of open
// work records with their next steps — the same "where the room stands"
// the client-side orient() computes from a snapshot, served to cold-HTTP
// agents with no client SDK.
//
// Everything returned is derivable from the activation pack plus the
// caller's own member record, so this adds no new visibility and has no
// DM-privacy implications. Unknown rooms surface the store's 404
// (room_not_found).
import { roomOrientation } from "../src/work-selectors.js";
import { nextWorkStep } from "../src/workflow.js";
import { pinnedMessages, roomKind, WORK_STATES } from "../src/events.js";
import { charterContext } from "../src/room-charter.js";
import { annotateOrientation, claimNote, withContentTrust } from "./content-trust.mjs";
import { orientSections } from "./updates.mjs";
import { fleetSelf } from "./agent-fleet.mjs";
import { ServiceError } from "./store.mjs";
import { messageVisibleToViewer, summaryHistoryFloor } from "./history-visibility.mjs"; // QA4 Q4-SEC-1
// Lane9 guest->member ladder: the `you.standing` block answers "where do I
// stand and what's next". Read-side only — it folds the existing bounty and
// claim reputation projectors for the caller and names the concrete next
// rung. It never changes enforcement, tiers, or permissions.
import { getTier, DEFAULT_AUTONOMY_TIER } from "./autonomy-tiers.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import {
  reputationSummary as bountyReputationSummary,
  PROBATION_MAX_CLAIM_CREDITS,
} from "./bounty-reputation.mjs";
import {
  projectClaimReputation,
  claimReputationSummary,
  HOARDING_CAP,
} from "./claim-reputation.mjs";
import { TRUSTED_BAND_MIN } from "./reputation.mjs";

// Work states that count as open; completed and superseded work is history,
// not something an arriving agent should pick up.
const OPEN_WORK_STATES = new Set([
  WORK_STATES.PROPOSED, WORK_STATES.ACCEPTED, WORK_STATES.WORKING, WORK_STATES.BLOCKED
]);

// Orientation is a glance, not a dump.
const MAX_WORK = 50;

const memberOf = member => ({
  id: member.id,
  handle: member.displayName,
  kind: member.kind,
  permissions: [...member.permissions],
  active: member.active !== false
});

// --- Standing block (lane9, guest->member ladder) --------------------------
// "Where do I stand and what's next", computed for the caller only. Every
// sub-block degrades to null on any failure (missing tables, missing
// escrow, malformed rows) — orient stays a glance, never a 500.

const round2 = n => typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : n;

// Raw work_claim.updated event rows for one room, shaped for the claim
// projector's fold. Mirrors syncClaimReputationJournal's row shape without
// touching the journal (journal wiring stays analytics-lane owned).
function claimEventRows(db, roomId) {
  let rows;
  try {
    rows = db.prepare(
      `SELECT sequence AS seq, body FROM events
       WHERE room_id=? AND json_extract(body,'$.type')='work_claim.updated'
       ORDER BY sequence`
    ).all(roomId);
  } catch {
    return null;
  }
  const out = [];
  for (const row of rows) {
    try {
      const body = JSON.parse(row.body);
      const atMs = Date.parse(body?.at);
      if (!Number.isFinite(atMs) || !body?.data || typeof body.data !== "object") continue;
      out.push({ roomId, seq: row.seq, atMs, data: body.data });
    } catch { /* skip malformed rows */ }
  }
  return out;
}

// The concrete next rung(s) for this member, computed from current state.
// Each rung names the action AND the mechanism (route, criteria, numbers) —
// the legibility gap the ladder audit found was criteria living only in code.
function nextRungs({ roomId, viewerId, isGuest, guestTier, autonomyTier, bounty, claims }) {
  const rungs = [];
  if (isGuest && guestTier === "observer") {
    rungs.push({
      rung: "contributor",
      action: "ask the room owner to upgrade your guest tier",
      how: `the owner runs POST /api/rooms/${roomId}/guest-invites-upgrade with your member id (${viewerId})`,
      why: "contributors can also post drafts; observers can read, post and react",
    });
  }
  if (isGuest) {
    rungs.push({
      rung: "member",
      action: "join as a full member for work claims, bounties, polls and grants",
      how: "mint an agent identity (POST /api/agent-identities), then redeem an agent invite, a referral token, or submit an access request",
      why: "guests are read/chat only and are never counted in poll tallies",
    });
  }
  if (autonomyTier === "t1_readonly") {
    rungs.push({
      rung: "t2_standard",
      action: "ask the room owner to restore full autonomy",
      how: `the owner manages tiers at PUT /api/rooms/${roomId}/operator/agents/${viewerId}`,
      why: "read-only members can read and report session status but cannot post work or claim",
    });
  }
  if (bounty?.band === "probation") {
    rungs.push({
      rung: "standard",
      action: "rebuild bounty standing",
      how: `each accepted bounty submission earns +4; probation caps new bounty claims at ${PROBATION_MAX_CLAIM_CREDITS} credits until the band recovers; scores decay toward neutral over ~30 days`,
    });
  }
  if (claims?.band === "probation") {
    rungs.push({
      rung: "standard",
      action: "rebuild claim standing",
      how: "each finished claim earns +3 and a clean release +1; avoid letting leases expire (-6); scores decay toward neutral over ~30 days",
    });
  }
  if (claims?.atCap) {
    rungs.push({
      rung: "headroom",
      action: "free up claim capacity",
      how: `you hold ${claims.openClaims} open claims; opening more while at or above ${HOARDING_CAP} costs -4 reputation each — mark done or release cleanly to drop back under`,
    });
  }
  if (rungs.length === 0) {
    rungs.push({
      rung: "trusted",
      action: "keep shipping good work",
      how: `bounty standing reaches trusted at a score of ${TRUSTED_BAND_MIN} (payouts +8, accepted submissions +4); claim standing rises +3 per completed claim`,
    });
  }
  return rungs;
}

function standingBlock(store, roomId, viewerId) {
  const isGuest = isGuestAgentMemberId(viewerId);
  let guestTier = null;
  try {
    const raw = store.guestInvites?.guestTierOf?.(viewerId) ?? null;
    guestTier = isGuest ? (raw ?? "observer") : null;
  } catch {
    guestTier = isGuest ? "observer" : null;
  }
  let autonomyTier = null;
  try {
    autonomyTier = getTier(store.db, roomId, viewerId)?.autonomyTier ?? DEFAULT_AUTONOMY_TIER;
  } catch {
    autonomyTier = null;
  }
  let bounty = null;
  try {
    if (store.bountyEscrow) {
      const s = bountyReputationSummary(store.bountyEscrow, roomId, viewerId);
      bounty = {
        score: round2(s.score),
        band: s.band,
        maxClaimMillis: s.band === "probation" ? PROBATION_MAX_CLAIM_CREDITS * 1000 : null,
      };
    }
  } catch {
    bounty = null;
  }
  let claims = null;
  try {
    const rows = claimEventRows(store.db, roomId);
    if (rows) {
      const projected = projectClaimReputation(rows, { nowMs: store.now() });
      const s = claimReputationSummary(projected, viewerId);
      claims = {
        score: round2(s.score),
        band: s.band,
        openClaims: s.openClaims,
        atCap: s.atCap,
      };
    }
  } catch {
    claims = null;
  }
  return {
    class: isGuest ? "guest" : "member",
    guestTier,
    autonomyTier,
    reputation: { bounty, claims },
    nextRungs: nextRungs({ roomId, viewerId, isGuest, guestTier, autonomyTier, bounty, claims }),
  };
}

const workOf = (item, now) => {
  const next = nextWorkStep(item, now);
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    claimant: item.claim?.holderId ?? null,
    next: {
      action: next.action,
      label: next.label,
      memberId: next.memberId ?? null,
      needsAttention: next.needsAttention
    },
    untrusted: true,
    ...claimNote(item)
  };
};

// Opaque resume token for the event log: versioned, self-describing to the
// server, meaningless to clients. Encodes the room event sequence the
// payload was generated from.
const cursorOf = sequence =>
  Buffer.from(JSON.stringify({ v: 1, seq: sequence }), "utf8").toString("base64url");

const FOCUS = new Set(["conversation", "work", "review"]);
const CONVERSATION = new Set(["request", "mention", "dm", "invite_pending", "access_request"]);
const WORK_FOCUS = new Set(["claim_lease_expiring", "claim_ci_failed"]);
const REVIEW_FOCUS = new Set(["review_requested", "claim_changes_requested"]);

export function parseOrientQuery(params) {
  const focus = params?.focus ?? null;
  if (focus != null && !FOCUS.has(focus)) throw new ServiceError(422, "invalid_orient", "focus must be conversation, work, or review");
  const q = params?.q ?? null;
  if (q != null && (typeof q !== "string" || q.length > 200)) throw new ServiceError(422, "invalid_orient", "q must be at most 200 characters");
  let maxTokens = 2000;
  if (params?.maxTokens != null && params.maxTokens !== "") {
    maxTokens = Number(params.maxTokens);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000) {
      throw new ServiceError(422, "invalid_orient", "maxTokens must be an integer from 1 to 8000");
    }
  }
  return { focus, q: q || null, maxTokens, text: params?.text !== false };
}

function tokensOf(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 2);
}

function rankLines(lines, query, maxTokens) {
  const terms = [...new Set(tokensOf(query))];
  if (!terms.length) return { lines: [], tokens: 0 };
  const docs = lines.map(line => ({ ...line, tokens: tokensOf(line.text) }));
  const average = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / (docs.length || 1);
  const k1 = 1.2, b = 0.75, total = docs.length;
  const scored = docs.map(doc => {
    const counts = new Map();
    for (const token of doc.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const freq = counts.get(term) ?? 0;
      if (!freq) continue;
      const docsWith = docs.filter(entry => entry.tokens.includes(term)).length;
      const idf = Math.log(1 + (total - docsWith + 0.5) / (docsWith + 0.5));
      const denom = freq + k1 * (1 - b + b * (doc.tokens.length / (average || 1)));
      score += idf * (freq * (k1 + 1) / denom);
    }
    return { ...doc, score };
  }).filter(doc => doc.score > 0).sort((a, c) => c.score - a.score || (a.id < c.id ? -1 : 1));
  const kept = [];
  let used = 0;
  for (const doc of scored) {
    const cost = Math.max(1, doc.tokens.length);
    if (kept.length && used + cost > maxTokens) break;
    kept.push({ id: doc.id, source: doc.source, text: doc.text, score: Math.round(doc.score * 1000) / 1000, untrusted: true });
    used += cost;
    if (used >= maxTokens) break;
  }
  return { lines: kept, tokens: used };
}

function fleetSelfOrNull(store, roomSlug, room, viewerId) {
  try {
    const self = fleetSelf(store, roomSlug, room, viewerId);
    return self ? self : {};
  } catch { return {}; }
}

export function buildOrient(store, roomSlug, viewerId, options = {}) {
  // Unknown rooms fail here with the store's 404 (room_not_found).
  const { sequence, state } = store.room(roomSlug);
  if (!state.room) throw new Error("Room projection is missing its room record");
  const member = state.members?.[viewerId];
  if (!member) throw new Error("Viewer is not a member of this room");
  const now = store.now();
  const query = parseOrientQuery(options);
  const openWork = Object.values(state.workItems ?? {})
    .filter(item => item && OPEN_WORK_STATES.has(item.state))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const sections = orientSections(store, roomSlug, viewerId, { limit: 40 });
  const focusOf = query.focus === "conversation" ? CONVERSATION : query.focus === "work" ? WORK_FOCUS : query.focus === "review" ? REVIEW_FOCUS : null;
  const updates = (focusOf ? sections.updates.filter(item => focusOf.has(item.kind)) : sections.updates).slice(0, 10);
  let claims = [];
  try {
    claims = (store.workClaims?.list?.(roomSlug) ?? [])
      .filter(item => item?.owner === viewerId)
      .map(item => ({ id: item.id, title: item.title ?? item.id, state: item.state, untrusted: true }));
  } catch { claims = []; }
  let nextActions = [];
  if (options.token && store.nextActions?.list) {
    try {
      const listed = store.nextActions.list(options.token, roomSlug, { limit: 8, binding: options.binding ?? null });
      nextActions = listed.items.filter(item => item.action?.api).slice(0, 8).map(item => ({
        id: item.id, kind: item.kind, title: item.title,
        method: item.action.api.method, path: item.action.api.path
      }));
    } catch { nextActions = []; }
  }
  // QA4 Q4-SEC-1: pins and the ?q= search corpus only carry messages this
  // viewer may read (no other members' DMs, nothing before a since_join floor).
  const floor = summaryHistoryFloor(store, roomSlug, viewerId, sequence);
  const visible = message => messageVisibleToViewer(message, viewerId, floor);
  const pinned = pinnedMessages(state).filter(pin => visible(pin.message)).map(pin => ({
    messageId: pin.messageId, pinnedAt: pin.pinnedAt, authorId: pin.message.authorId,
    ...(query.text ? { text: pin.message.body, untrusted: true } : {})
  }));
  const lines = [
    ...pinned.filter(pin => pin.text).map(pin => ({ id: pin.messageId, source: "pinned", text: pin.text })),
    ...(state.messages ?? []).filter(visible).slice(-40).map(message => ({ id: message.id, source: "message", text: message.body })),
    ...claims.map(item => ({ id: item.id, source: "claim", text: item.title }))
  ];
  // A member with no published directory card is still orientable. Missing
  // cards throw directory_not_found; capabilities then stay the member's own.
  let card = null;
  try { card = store.agentPlugin?.directory?.get?.(viewerId) ?? null; }
  catch { card = null; }
  const capabilities = [...member.permissions, ...(Array.isArray(card?.capabilities) ? card.capabilities : [])];
  return withContentTrust({
    contract: { name: "project-room/orient", version: 1 },
    room: {
      slug: state.room.id,
      title: state.room.title,
      state: typeof state.room.archivedAt === "string" ? "archived" : "active",
      kind: roomKind(state.room)
    },
    member: memberOf(member),
    you: {
      member: memberOf(member),
      profile: { displayName: member.displayName, kind: member.kind, identityId: member.identityId ?? null },
      capabilities,
      // Lane9 ladder: where the caller stands (class, tiers, reputation
      // bands) and the concrete next rung(s). Read-side only.
      standing: standingBlock(store, roomSlug, viewerId),
      // CP-AGENTS-1: the calling agent's own fleet state (agents only).
      ...(member.kind === "agent" ? fleetSelfOrNull(store, roomSlug, { sequence, state }, viewerId) : {})
    },
    instructions: { charter: charterContext(state.room), pinned },
    focus: query.focus,
    updates,
    claims,
    workItems: openWork.filter(item => item.accountableMemberId === viewerId || item.claim?.holderId === viewerId || item.verifierMemberId === viewerId)
      .slice(0, MAX_WORK).map(item => workOf(item, now)),
    uncertain: sections.uncertain,
    nextActions,
    cursors: { eventCursor: cursorOf(sequence), evaluatedThrough: sequence, updates: updates.length },
    ...(query.q ? { matched: rankLines(lines, query.q, query.maxTokens) } : {}),
    evaluatedThrough: sequence,
    eventCursor: cursorOf(sequence),
    orientation: annotateOrientation(roomOrientation(state)),
    work: openWork.slice(0, MAX_WORK).map(item => workOf(item, now)),
    workTotal: openWork.length,
    links: { activationPack: `/api/rooms/${state.room.id}/activation-pack`, updates: `/api/rooms/${state.room.id}/updates` },
    generatedAt: new Date(now).toISOString()
  });
}
