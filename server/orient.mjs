import { messageRepository } from "./message-repository.mjs";
// Orient payload builder (jill lane, RC-2026-09-28 — ryska's 404).
//
// Read-only, member-scoped orientation payload: contract version, the
// authenticated member and their scope, room summary, evaluated-through
// sequence, and a bounded list of open work records with their next
// steps — the same "where the room stands" the client-side orient()
// computes from a snapshot. The standalone GET /api/rooms/{roomId}/orient
// endpoint was deleted (simplification register D1); this builder is the
// shared helper embedded by the activation pack, the context response,
// and the MCP room profile.
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
import { availableClaimsFromBoard, memoizeBoardList } from "./available-work.mjs";
import { contextVersion } from "./room-context.mjs";
import { workRoleHolder } from "./work-context.mjs";

// Context embeds current Board orientation as well as formal work. Decide
// conditional freshness only after composing both under the same read view.
// Transient updates, fleet assessments, next-action rankings and transport
// clocks/cursors are not structural context; they have their own fresh reads.
export function readComposedRoomContext(store, token, roomId, { sinceVersion = null, expectedSessionBinding = null, workAfter = "" } = {}) {
  return store.readTransaction(() => {
    let context = store.roomContext(token, roomId, { sinceVersion, expectedSessionBinding, workAfter });
    // A caller may still hold the old formal-only version from before this
    // composition contract. Refresh it once rather than omit its projection.
    if (context.not_modified) context = store.roomContext(token, roomId, { expectedSessionBinding, workAfter });
    // A structural version certifies a successful observation. Read the board
    // before the glance builder's catch-to-empty fallback so an unavailable
    // registry cannot be certified as an unchanged empty board. The surrounding
    // read transaction maps storage failures to its existing typed refusal.
    const board = context.workScope === "workWindow" ? null : store.workClaims.list(roomId);
    const options = {
      text: false, token, binding: expectedSessionBinding, workAfter, boardList: () => board
    };
    const orient = buildOrient(store, roomId, context.viewerId, { ...options, structuralOnly: true });
    const { room, member, instructions, claims, availableClaims, workItems, orientation, work, workTotal, links } = orient;
    const version = contextVersion({ formal: context.context_version, orientation: {
      room, member, instructions, claims, availableClaims, workItems, orientation, work, workTotal, links,
      profile: orient.you.profile, capabilities: orient.you.capabilities
    } });
    if (sinceVersion === version) {
      return {
        not_modified: true, context_version: version, roomId,
        evaluatedThrough: context.evaluatedThrough, evaluatedAt: context.evaluatedAt, cursors: context.cursors,
        viewerId: context.viewerId, viewerAccountId: context.viewerAccountId, viewerAuthEpoch: context.viewerAuthEpoch,
        viewerSessionBinding: context.viewerSessionBinding, viewerSessionRevision: context.viewerSessionRevision
      };
    }
    return { ...context, context_version: version, orient: buildOrient(store, roomId, context.viewerId, options) };
  });
}

function withPrivateDefinitionsWithheld(store, roomSlug, state, viewerId) {
  const privatePartiesByWork = typeof store.privateWorkParties === "function" ? store.privateWorkParties(roomSlug) : null;
  if (!privatePartiesByWork?.size || !state.workItems) return state;
  let changed = false;
  const workItems = Object.fromEntries(Object.entries(state.workItems).map(([id, item]) => {
    const parties = privatePartiesByWork.get(id);
    if (!item || !parties || parties.has(viewerId) || workRoleHolder(item, viewerId)) return [id, item];
    changed = true;
    return [id, { ...item, title: null, definitionOfDone: null }];
  }));
  return changed ? { ...state, workItems } : state;
}

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

// eventCursor is the room's numeric event sequence — the value the event
// log actually resumes from (GET …/events?after=<seq>, SSE Last-Event-ID).
// It was previously an opaque base64url token that no endpoint parsed back
// (#3222), so the cursor this payload handed out could not be used anywhere.

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
    // maxTokens is a hard budget: a line whose cost alone exceeds the
    // remaining budget is never kept (not even as the first/only line) —
    // skip it and keep scanning for lower-ranked lines that do fit.
    if (used + cost > maxTokens) continue;
    kept.push({ id: doc.id, source: doc.source, text: doc.text, score: Math.round(doc.score * 1000) / 1000, untrusted: true });
    used += cost;
    if (used >= maxTokens) break;
  }
  return { lines: kept, tokens: used };
}

function fleetSelfOrNull(store, roomSlug, room, viewerId, boardList = null) {
  try {
    const self = fleetSelf(store, roomSlug, room, viewerId, { boardList });
    return self ? self : {};
  } catch { return {}; }
}

// Board claims an arriving member can pick up right now (#3020) come from
// the AvailableWork projection (server/available-work.mjs) — the ONE
// availability definition every discovery surface consumes, so orient and
// the activation pack cannot diverge. The `claims` list below stays the
// viewer's own claims; `work`/`openWork` still derive from Work Items.

export function buildOrient(store, roomSlug, viewerId, options = {}) {
  const overview=store.currentOverview?.(roomSlug,viewerId,{workAfter:options.workAfter??''});
  if(overview) {
    const query=parseOrientQuery(options);
    if(query.q)throw new ServiceError(409,'current_room_context_unavailable','Orient text search requires an indexed query preserving its corpus semantics');
    const {state,visibleSequence:sequence,workWindow}=overview,member=Object.getOwnPropertyDescriptor(state.members,viewerId).value,now=store.now();
    const work=Object.values(state.workItems).filter(item=>OPEN_WORK_STATES.has(item.state));
    return withContentTrust({contract:{name:'project-room/orient',version:1},
      room:{slug:state.room.id,title:state.room.title,state:state.room.archivedAt?'archived':'active',kind:roomKind(state.room)},
      member:memberOf(member),you:{member:memberOf(member),profile:{displayName:member.displayName,kind:member.kind,identityId:member.identityId??null},capabilities:[...member.permissions]},
      instructions:{charter:charterContext(state.room)},focus:query.focus,
      workItems:work.filter(item=>item.accountableMemberId===viewerId||item.claim?.holderId===viewerId||item.verifierMemberId===viewerId).map(item=>workOf(item,now)),
      work:work.map(item=>workOf(item,now)),workTotal:workWindow.complete?work.length:null,workWindow,workScope:'workWindow',
      omitted:['message_updates','board_claims','fleet','next_actions','pinned_message_bodies','full_room_orientation'],
      cursors:{eventCursor:sequence,evaluatedThrough:sequence},evaluatedThrough:sequence,eventCursor:sequence,
      links:{activationPack:`/api/rooms/${state.room.id}/activation-pack`},generatedAt:new Date(now).toISOString()});
  }
  // Unknown rooms fail here with the store's 404 (room_not_found).
  const { sequence, state: rawState } = store.room(roomSlug);
  if (!rawState.room) throw new Error("Room projection is missing its room record");
  // Private work definitions: the same predicate as default orientation
  // (agent-orientation.mjs) — a non-party, non-role-holder sees the item
  // with title and definitionOfDone withheld, on every orient consumer.
  const state = withPrivateDefinitionsWithheld(store, roomSlug, rawState, viewerId);
  const member = state.members?.[viewerId];
  if (!member) throw new Error("Viewer is not a member of this room");
  const now = store.now();
  // PERF-10X L4: the board is decoded ONCE per request. Every board
  // consumer in this payload — the claims sections below, the fleet badge
  // (agent viewers), and the next-actions snapshot (token callers) —
  // shares this per-request memo; a caller composing several reads in one
  // request (activation pack, context) passes its own memo in.
  const sharedBoardList = options.boardList ?? memoizeBoardList(store);
  // Board rows carry their own title, so the private-definition boundary
  // applied to state.workItems above must also cover every board consumer
  // (availableClaims, claims, next actions, fleet badge).
  const withheldIds = new Set(Object.keys(state.workItems ?? {})
    .filter(id => state.workItems[id] !== rawState.workItems?.[id]));
  const boardList = withheldIds.size === 0 ? sharedBoardList : slug => {
    const rows = sharedBoardList(slug);
    if (slug !== roomSlug || !Array.isArray(rows)) return rows;
    return rows.map(row => (row && withheldIds.has(row.workItemId)
      ? { ...row, title: null, ...(row.definitionOfDone !== undefined ? { definitionOfDone: null } : {}) }
      : row));
  };
  // Internal version checks need only the structural fields. Defer transient
  // attention, fleet and action reads until a full response is actually sent.
  const structuralOnly = options.structuralOnly === true;
  const query = parseOrientQuery(options);
  const openWork = Object.values(state.workItems ?? {})
    .filter(item => item && OPEN_WORK_STATES.has(item.state))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const sections = structuralOnly ? { updates: [], uncertain: [] } : orientSections(store, roomSlug, viewerId, { limit: 40 });
  const focusOf = query.focus === "conversation" ? CONVERSATION : query.focus === "work" ? WORK_FOCUS : query.focus === "review" ? REVIEW_FOCUS : null;
  const updates = (focusOf ? sections.updates.filter(item => focusOf.has(item.kind)) : sections.updates).slice(0, 10);
  let claims = [];
  let availableClaims = [];
  try {
    const board = boardList(roomSlug);
    claims = board
      .filter(item => item?.owner === viewerId)
      .map(item => ({ id: item.id, title: item.title ?? item.id, state: item.state, untrusted: true }));
    availableClaims = availableClaimsFromBoard(board, roomSlug, { viewerId, state }).slice(0, MAX_WORK);
  } catch { claims = []; availableClaims = []; }
  let nextActions = [];
  if (!structuralOnly && options.token && store.nextActions?.list) {
    try {
      const listed = store.nextActions.list(options.token, roomSlug, { limit: 8, binding: options.binding ?? null, boardList });
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
  const lines = query.q ? [
    ...pinned.filter(pin => pin.text).map(pin => ({ id: pin.messageId, source: "pinned", text: pin.text })),
    ...messageRepository(store, roomSlug, state).recent(40, visible).map(message => ({ id: message.id, source: "message", text: message.body })),
    ...claims.map(item => ({ id: item.id, source: "claim", text: item.title }))
  ] : [];
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
      // CP-AGENTS-1: the calling agent's own fleet state (agents only).
      ...(member.kind === "agent" && !structuralOnly ? fleetSelfOrNull(store, roomSlug, { sequence, state }, viewerId, boardList) : {})
    },
    instructions: { charter: charterContext(state.room), pinned },
    focus: query.focus,
    updates,
    claims,
    availableClaims,
    workItems: openWork.filter(item => item.accountableMemberId === viewerId || item.claim?.holderId === viewerId || item.verifierMemberId === viewerId)
      .slice(0, MAX_WORK).map(item => workOf(item, now)),
    uncertain: sections.uncertain,
    nextActions,
    cursors: { eventCursor: sequence, evaluatedThrough: sequence, updates: updates.length },
    ...(query.q ? { matched: rankLines(lines, query.q, query.maxTokens) } : {}),
    evaluatedThrough: sequence,
    eventCursor: sequence,
    orientation: annotateOrientation(roomOrientation(state)),
    work: openWork.slice(0, MAX_WORK).map(item => workOf(item, now)),
    workTotal: openWork.length,
    links: { activationPack: `/api/rooms/${state.room.id}/activation-pack`, updates: `/api/rooms/${state.room.id}/updates` },
    generatedAt: new Date(now).toISOString()
  });
}
