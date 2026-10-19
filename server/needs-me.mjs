import { sessionWatermark } from "./read-cursor.mjs";
// Cross-room "what needs me" for one identity.
//
// One read replaces listing rooms and then opening each inbox. Items are
// mentions, direct reply asks, open handoffs, unread DMs, bond requests,
// and land-queue rows this member owns that have changed. Each item carries
// roomId, a seq cursor, and a suggested next tool call. Standing sections
// ride beside items and never move the cursor: openWork (ready Board work),
// reviewAsks (deliveries naming me as reviewer), myWork (my claims whose
// lease is expiring or that sit idle), myClaims (every open claim I own,
// with its state and next lifecycle step), and actionsNeeded (my claims
// whose recorded CI failed or whose current delivery drew a
// changes-requested review). myClaims/actionsNeeded (agent-inbox v1) close
// the last gap where a polling agent had to re-read a whole room or board
// to answer "what is mine and what is broken": the CI rollup and reviews
// already live on the claim record (recordCi / recordReview), so these
// sections compose that state instead of recomputing it.
//
// since is a sequence number (applied per room) or the previous cursor
// { rooms: { roomId: seq }, land: { roomId: updatedAt } }. Land-queue
// changes do not advance the room sequence, so they use updated_at.
// Pass cursor back unchanged while hasMore is true, even for an empty page.
// Continuation adds roomAfter, landIds (timestamp tie breakers), and an optional
// numeric floor. Answered, handled, and cleared updates leave this list even
// when the caller does not pass a cursor.

import { ServiceError } from "./store.mjs";
import { nextWorkStep } from "../src/workflow.js";
import { retiredNeedsMeKeys } from "./updates.mjs";
import { mayWriteWorkClaims } from "./work-claim-routes.mjs";
import { availableBoardRows } from "./available-work.mjs";
import { claimUpdatedAt, isHardWork, releaseExpired, resolveNamedReviewers, hasCurrentReview, deliveryLeaseLapsed, CLAIM_LIFECYCLE, ACTIVE_CLAIM_STATES } from "./work-claims.mjs";
import { claimIdle } from "./agent-fleet.mjs";
import { identityRoomSeats } from "./membership-resolution.mjs";
import { SQL_BIND_CHUNK } from "./sql-binds.mjs";

const MAX_ROOMS = 40;
const MAX_PER_KIND = 8;
const MAX_ITEMS = 100;
// Open work: unclaimed, ready Board items this member may claim. Measured in
// muse-room on 2026-10-05: 21 of 21 items posted for someone else to pick up
// were never claimed (oldest 88h), because the one read every agent polls
// listed none of them. It is standing state, not an event, so it rides beside
// items, never moves the cursor, and shows even when nothing else is new.
const OPEN_WORK_SHOWN = 3;
const OPEN_WORK_TITLE = 80;
const MY_WORK_SHOWN = 5;
const MY_ACTIVE_STATES = new Set(["claimed", "in_progress"]);
export const LEASE_SOON_MS = 3_600_000;
const MENTION_WINDOW = 100;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const clip = text => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 140 ? `${value.slice(0, 139)}…` : value;
};

// B4 agent read-path: a one-line triage snippet for Board section entries,
// which otherwise carry only the (80-char) title — an agent had to re-read
// the whole Board to learn what a listed claim is about. Source order: the
// first acceptance criterion (what "done" looks like), else the newest
// history note (create / finish / review notes ride the claim's history).
const claimSnippet = claim => {
  const criteria = Array.isArray(claim?.acceptanceCriteria) ? claim.acceptanceCriteria : [];
  const criterion = criteria.find(entry => typeof entry === "string" && entry.trim());
  if (criterion) return clip(criterion);
  const history = Array.isArray(claim?.history) ? claim.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const note = history[index]?.note;
    if (typeof note === "string" && note.trim()) return clip(note);
  }
  return null;
};
const snippetField = claim => {
  const snippet = claimSnippet(claim);
  return snippet ? { snippet } : {};
};

function integerMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || key.length < 1 || key.length > 128) return null;
    const number = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(number) || number < 0) return null;
    out[key] = number;
  }
  return out;
}

export function parseNeedsMeSince(since) {
  if (since == null || since === "") return { provided: false, number: null, rooms: {}, land: {} };
  if (typeof since === "number") {
    if (!Number.isSafeInteger(since) || since < 0) fail(422, "invalid_cursor", "since must be a sequence number or a cursor object");
    return { provided: true, number: since, rooms: {}, land: {} };
  }
  if (typeof since === "string") {
    const trimmed = since.trim();
    if (/^\d+$/.test(trimmed)) return parseNeedsMeSince(Number(trimmed));
    try { return parseNeedsMeSince(JSON.parse(trimmed)); }
    catch { fail(422, "invalid_cursor", "since must be a sequence number or a cursor object"); }
  }
  if (typeof since === "object" && !Array.isArray(since)) {
    const wrapped = Object.hasOwn(since, "rooms") || Object.hasOwn(since, "land");
    const rooms = integerMap(wrapped ? since.rooms ?? {} : since);
    const land = integerMap(wrapped ? since.land ?? {} : {});
    if (!rooms || !land) fail(422, "invalid_cursor", "since must be a sequence number or a cursor object");
    const landIds = wrapped ? since.landIds ?? {} : {};
    const roomAfter = wrapped ? since.roomAfter ?? "" : "";
    const floor = wrapped ? since.floor ?? null : null;
    if (!landIds || typeof landIds !== "object" || Array.isArray(landIds)
      || Object.entries(landIds).some(([key, value]) => key.length > 128 || typeof value !== "string" || value.length > 256)
      || typeof roomAfter !== "string" || roomAfter.length > 128
      || (floor !== null && (!Number.isSafeInteger(floor) || floor < 0))) {
      fail(422, "invalid_cursor", "Invalid continuation cursor");
    }
    return { provided: true, number: floor, rooms, land, landIds, roomAfter };
  }
  fail(422, "invalid_cursor", "since must be a sequence number or a cursor object");
}

function roomWatermark(parsed, roomId) {
  if (!parsed.provided) return 0;
  if (Object.hasOwn(parsed.rooms, roomId)) return parsed.rooms[roomId];
  return parsed.number ?? 0;
}

function landWatermark(parsed, roomId) {
  if (!parsed.provided) return 0;
  return Object.hasOwn(parsed.land, roomId) ? parsed.land[roomId] : 0;
}

function eventSeq(store, roomId, eventId) {
  if (typeof eventId !== "string" || !eventId) return null;
  return store.db.prepare("SELECT sequence FROM events WHERE room_id=? AND id=?").get(roomId, eventId)?.sequence ?? null;
}

function push(items, item) {
  if (!Number.isSafeInteger(item.seq) || item.seq < 0) return;
  items.push(item);
}

function mentionsOf(store, roomId, memberId, after, through) {
  let rows;
  try { rows = store.openDirectMentions(roomId, memberId, MENTION_WINDOW, store.now(), { after, through }); }
  catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return [];
    throw error;
  }
  return rows.filter(row => row.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, MAX_PER_KIND + 1).map(row => ({
    kind: "mention",
    roomId,
    seq: row.sequence,
    id: row.messageId ?? row.eventId,
    summary: clip(row.body),
    next: {
      tool: "room_reply",
      arguments: {
        roomId,
        requestId: `needs-me-${roomId}-${row.replyToId ?? row.messageId ?? row.eventId}`,
        replyToId: row.replyToId,
        ...(row.private && row.replyToMemberId ? { toMemberId: row.replyToMemberId } : {})
      }
    }
  }));
}

function directAsksOf(store, roomId, memberId, after, state) {
  const requests = Object.values(state.replyRequests ?? {})
    .filter(request => request?.recipientId === memberId && request.status === "open");
  const items = [];
  for (const request of requests) {
    const seq = eventSeq(store, roomId, request.openingEventId);
    if (seq == null || seq <= after) continue;
    items.push({
      kind: "direct_ask",
      roomId,
      seq,
      id: request.id,
      summary: clip(`Reply requested by ${request.requesterId}`),
      next: { tool: "room_read_request", arguments: { roomId, requestMessageId: request.id } }
    });
  }
  return items.sort((a, b) => a.seq - b.seq).slice(0, MAX_PER_KIND + 1);
}

function handoffsOf(store, roomId, memberId, after, state) {
  const items = [];
  for (const item of Object.values(state.workItems ?? {})) {
    const handoff = item?.handoff;
    if (!handoff?.open) continue;
    const addressed = handoff.triageMemberId === memberId
      || nextWorkStep(item, store.now(), state.room?.ownerId ?? null).memberId === memberId;
    if (!addressed) continue;
    const seq = eventSeq(store, roomId, handoff.eventId);
    if (seq == null || seq <= after) continue;
    items.push({
      kind: "handoff",
      roomId,
      seq,
      id: item.id,
      summary: clip(handoff.nextAction || handoff.doneSummary || item.title),
      next: { tool: "room_read_work", arguments: { roomId, workItemId: item.id } }
    });
  }
  return items.sort((a, b) => a.seq - b.seq).slice(0, MAX_PER_KIND + 1);
}

function roomDmsOf(store, roomId, memberId, after, state) {
  // The event log holds the body as originally posted; the live projection
  // (state.messages) is the current state. A DM deleted after posting must
  // not surface at all (its logged body is already scrubbed, so it showed
  // as an empty item inviting a reply to a tombstone), and an edited DM
  // must show its current body, not the pre-edit text. Messages missing
  // from the projection (e.g. archived out of it) fall back to the logged
  // body, as deriveNotifications does.
  const currentById = new Map((state?.messages ?? []).map(message => [message.id, message]));
  const items = [];
  // Scan in batches: a deleted DM must not consume one of the
  // MAX_PER_KIND + 1 slots, or the caller's overflow check (kind length >
  // MAX_PER_KIND lowers the cursor horizon) would advance the cursor past
  // live DMs that were never returned.
  let cursor = after;
  while (items.length <= MAX_PER_KIND) {
    const rows = store.db.prepare(
      `SELECT sequence, body FROM events
       WHERE room_id=? AND sequence>? AND json_extract(body,'$.type')='message.posted'
         AND json_extract(body,'$.data.toMemberId')=?
       ORDER BY sequence ASC LIMIT ?`
    ).all(roomId, cursor, memberId, MAX_PER_KIND + 1);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.sequence;
      const event = JSON.parse(row.body);
      const messageId = event.data?.messageId ?? event.id;
      const current = currentById.get(messageId);
      if (current?.deletedAt) continue;
      items.push({
        kind: "dm",
        roomId,
        seq: row.sequence,
        id: messageId,
        channel: "room",
        summary: clip(current ? current.body : event.data?.body),
        next: {
          tool: "room_reply",
          arguments: { roomId, requestId: `needs-me-${roomId}-${messageId}`, replyToId: messageId, ...(event.actorId ? { toMemberId: event.actorId } : {}) }
        }
      });
      if (items.length > MAX_PER_KIND) break;
    }
    if (rows.length < MAX_PER_KIND + 1) break;
  }
  return items;
}

function peerDmsOf(store, roomId, identityId, after) {
  if (!identityId) return [];
  const rows = store.db.prepare(
    `SELECT e.sequence AS seq, m.message_id AS messageId, m.thread_id AS threadId, m.body AS body
     FROM peer_dm_messages m
     JOIN events e ON e.room_id=m.room_id AND e.id=m.event_id
     WHERE m.to_identity_id=? AND m.room_id=? AND e.sequence>?
     ORDER BY e.sequence ASC LIMIT ?`
  ).all(identityId, roomId, after, MAX_PER_KIND + 1);
  return rows.map(row => ({
    kind: "dm",
    roomId,
    seq: row.seq,
    id: row.messageId,
    channel: "peer",
    summary: clip(row.body),
    next: { tool: "room_list_peer_dms", arguments: { roomId, threadId: row.threadId } }
  }));
}

function bondRequestsOf(store, roomId, pending, after) {
  const mine = pending.filter(row => row.roomHint === roomId);
  // One query per chunk, not one per bond: the per-bond lookup has no index on
  // the bondId extract, so each bond costs a full scan of the room's events.
  // GROUP BY returns the same latest (MAX) sequence per bondId.
  const seqByBond = new Map();
  // SQL_BIND_CHUNK, not 900: the Worker's SQL takes at most 100 binds.
  for (let i = 0; i < mine.length; i += SQL_BIND_CHUNK) {
    const chunk = mine.slice(i, i + SQL_BIND_CHUNK);
    const rows = store.db.prepare(
      `SELECT json_extract(body,'$.data.bondId') AS bondId, MAX(sequence) AS sequence FROM events
       WHERE room_id=? AND json_extract(body,'$.type')='bond.proposed'
         AND json_extract(body,'$.data.bondId') IN (${chunk.map(() => "?").join(",")})
       GROUP BY json_extract(body,'$.data.bondId')`
    ).all(roomId, ...chunk.map(bond => bond.bondId));
    for (const row of rows) seqByBond.set(row.bondId, row.sequence);
  }
  const items = [];
  for (const bond of mine) {
    const seq = seqByBond.get(bond.bondId) ?? null;
    if (seq == null || seq <= after) continue;
    items.push({
      kind: "bond_request",
      roomId,
      seq,
      id: bond.bondId,
      summary: clip(`Bond request from ${bond.fromIdentityId}`),
      next: { tool: "bond_accept", arguments: { roomId, bondId: bond.bondId } }
    });
  }
  return items.sort((a, b) => a.seq - b.seq).slice(0, MAX_PER_KIND + 1);
}

function landChangesOf(store, roomId, memberId, after, afterId) {
  let rows;
  try {
    rows = store.db.prepare(
      `SELECT item_id, repo, pr_number, updated_at, title, checks_state
       FROM land_queue
       WHERE room_id=? AND claimant_member_id=? AND (updated_at>? OR (updated_at=? AND item_id>?))
         AND (observed=1 OR updated_at>created_at)
       ORDER BY updated_at ASC, item_id ASC LIMIT ?`
    ).all(roomId, memberId, after, after, afterId ?? "\uffff", MAX_PER_KIND + 1);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return [];
    throw error;
  }
  return rows.map(row => ({
    kind: "land_queue",
    roomId,
    seq: row.updated_at,
    id: row.item_id,
    summary: clip(row.title || `${row.repo}#${row.pr_number} ${row.checks_state}`),
    next: { tool: "list_land_queue", arguments: { roomId } }
  }));
}

function mentionHorizon(store, roomId, memberId, after, through) {
  try {
    const rows = store.db.prepare(
      `SELECT e.sequence FROM mention_states m
       JOIN events e ON e.room_id=m.room_id AND e.id=m.message_event_id
       WHERE m.room_id=? AND m.mentioned_member_id=? AND e.sequence>? AND e.sequence<=?
         AND m.state IN ('delivered','acknowledged','timed_out')
       ORDER BY e.sequence LIMIT ?`
    ).all(roomId, memberId, after, through, MENTION_WINDOW + 1);
    return rows.length > MENTION_WINDOW ? rows[MENTION_WINDOW - 1].sequence : through;
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return through;
    throw error;
  }
}

// One read of the claim board, shared by a room's work sections. Each used
// to list (and JSON-decode) the whole board separately — 80-175ms per read
// at 400 claims on muse-room scale. Returns null when the list fails, which
// each section treats as "no data".
//
// The rows are derived through the kernel's own lease-liveness rule
// (releaseExpired) before any section reads them (#3898): lease release is
// persisted only as a side effect of other traffic (the board routes'
// sweep, the claim-prs job), so on a quiet board the stored row can call a
// claim "held" days after its lease lapsed — and needs-me served it as
// held, with a forward next verb and a ci_failed action. Deriving here,
// once, keeps every section in agreement with the domain: a lapsed claim
// is unclaimed with no owner. The derivation is pure — stored rows change
// only when a real sweep runs — and a derivation failure falls back to
// the raw rows rather than blanking the inbox.
function claimBoardOf(store, roomId) {
  let list = null;
  try { list = store.workClaims?.list(roomId) ?? []; } catch { return null; }
  if (!list) return null;
  try { return releaseExpired(list, typeof store.now === "function" ? store.now() : Date.now()); }
  catch { return list; }
}

// The cursor acknowledges discovery, not completion. Only advance through
// sequence groups returned in full; multiple attention kinds may share an event.
export function openWorkOf(store, roomId, memberId, authority, claims = null, nowMs = Date.now()) {
  const member = authority?.members?.[memberId];
  const ownerId = typeof authority?.ownerId === "string" && authority.ownerId ? authority.ownerId : null;
  if (!member || !mayWriteWorkClaims({ member: { ...member, id: memberId }, ownerId })) return null;
  const list = claims ?? claimBoardOf(store, roomId);
  if (!list) return null;
  // Ready = the AvailableWork projection's board rule (available-work.mjs):
  // usable (not invalidated — invalidated work keeps its original state for
  // the audit trail, and neither that state nor a retired scope proves a
  // usable dependency), unclaimed, kind "work", every dependency done.
  // This section used to keep a private copy of that filter; it now
  // consumes the one definition the pack/orient/public surfaces share.
  const updatedMs = item => {
    const ms = Date.parse(claimUpdatedAt(item));
    return Number.isFinite(ms) ? ms : null;
  };
  // Sort on the exact timestamp; round to minutes only for display.
  const minutesSince = ms => (ms === null ? null : Math.max(0, Math.round((nowMs - ms) / 60000)));
  // Board order (updatedAt desc, then id) within each group, as the Board shows.
  const ready = availableBoardRows(list)
    .map(item => ({ item, at: updatedMs(item), released: (item.history ?? []).some(entry => entry?.action === "claimed"),
      hard: isHardWork(item) }))
    // Hard items (tag hard / hard-problem) first: they are the ones that stall
    // unpicked. Then work posted for pickup (never claimed); released or
    // lease-expired items can be finished work handed back without "done".
    .sort((a, b) => Number(b.hard) - Number(a.hard) || Number(a.released) - Number(b.released)
      || (b.at ?? -Infinity) - (a.at ?? -Infinity) || String(a.item.id).localeCompare(String(b.item.id)))
    .map(row => ({ ...row, idleMinutes: minutesSince(row.at) }));
  if (!ready.length) return null;
  const idles = ready.map(row => row.idleMinutes).filter(value => value !== null);
  return {
    roomId,
    count: ready.length,
    neverClaimed: ready.filter(row => !row.released).length,
    ...(ready.some(row => row.hard) ? { hard: ready.filter(row => row.hard).length } : {}),
    ...(idles.length ? { oldestIdleMinutes: Math.max(...idles) } : {}),
    top: ready.slice(0, OPEN_WORK_SHOWN).map(({ item, idleMinutes, released, hard }) => ({
      id: item.id,
      ...(hard ? { hard: true, reviewPolicy: item.reviewPolicy ?? "self_attested" } : {}),
      title: String(item.title ?? "").slice(0, OPEN_WORK_TITLE),
      ...snippetField(item),
      ...(idleMinutes !== null ? { idleMinutes } : {}),
      ...(released ? { released: true } : {}),
      ...(item.tags?.length ? { tags: item.tags.slice(0, 3) } : {})
    })),
    next: `POST /api/rooms/${encodeURIComponent(roomId)}/work-claims/{id}/claim`
  };
}

// Review asks (hw-h2-needs-me-review-asks): open items that name this member
// as reviewer (tag rev-<memberId>) and are ready to review (in_progress or a
// linked PR). Standing state like openWork: it never moves the cursor, it
// retires when the member records a review on the current basis, and it
// returns when the head moves.
export function reviewAsksOf(store, roomId, memberId, authority, claims = null) {
  const list = claims ?? claimBoardOf(store, roomId);
  if (!list) return null;
  const asks = list.filter(item => item && item.state !== "done" && !item.supersededBy && item.owner && item.owner !== memberId
      && resolveNamedReviewers(item, authority?.members).includes(memberId)
      && (item.state === "in_progress" || item.pullRequest || (item.pullRequests ?? []).length)
      && !hasCurrentReview(item, memberId))
    .sort((a, b) => String(claimUpdatedAt(b) ?? "").localeCompare(String(claimUpdatedAt(a) ?? "")) || String(a.id).localeCompare(String(b.id)));
  if (!asks.length) return null;
  return {
    roomId,
    count: asks.length,
    top: asks.slice(0, OPEN_WORK_SHOWN).map(item => ({
      id: item.id,
      title: String(item.title ?? "").slice(0, OPEN_WORK_TITLE),
      ...snippetField(item),
      owner: item.owner,
      ...(item.pullRequest?.url ? { pullRequest: item.pullRequest.url } : {}),
      ...(item.ci?.headSha ? { headSha: item.ci.headSha } : {}),
      ...(item.revision ? { revision: item.revision } : {})
    })),
    next: `POST /api/rooms/${encodeURIComponent(roomId)}/work-claims/{id}/review`
  };
}

// The caller's own held claims that need attention, so the one inbox carries
// them: a lease that lapses within the hour, or a claim idle for 2h
// (agent-fleet claimIdle). Reviews owed are reviewAsks (rev-<memberId>,
// hw-h2-needs-me-review-asks), not repeated here. Standing state like
// openWork: never moves the cursor.
export function myWorkOf(store, roomId, memberId, claims = null, nowMs = Date.now()) {
  const list = claims ?? claimBoardOf(store, roomId);
  if (!list) return null;
  const title = item => String(item.title ?? item.id).slice(0, OPEN_WORK_TITLE);
  const rows = [];
  for (const item of list) {
    if (!item || !MY_ACTIVE_STATES.has(item.state)) continue;
    if (item.owner === memberId) {
      const left = item.leaseExpiresAt ? Date.parse(item.leaseExpiresAt) - nowMs : NaN;
      if (left > 0 && left <= LEASE_SOON_MS) {
        rows.push({ id: item.id, title: title(item), ...snippetField(item), why: "lease_expiring", minutesLeft: Math.ceil(left / 60000) });
      } else if (claimIdle(item, nowMs)) {
        const idleMinutes = Math.round((nowMs - Date.parse(claimUpdatedAt(item) || item.claimedAt)) / 60000);
        rows.push({ id: item.id, title: title(item), ...snippetField(item), why: "claim_idle", ...(Number.isFinite(idleMinutes) ? { idleMinutes } : {}) });
      }
    }
  }
  if (!rows.length) return null;
  const rank = { lease_expiring: 0, claim_idle: 1 };
  rows.sort((a, b) => rank[a.why] - rank[b.why] || String(a.id).localeCompare(String(b.id)));
  return { roomId, count: rows.length, top: rows.slice(0, MY_WORK_SHOWN) };
}

const MY_CLAIMS_SHOWN = 10;
const ACTIONS_NEEDED_SHOWN = 8;
const MY_CLAIM_STATES = new Set([...ACTIVE_CLAIM_STATES, "delivered"]);

// The owner's next lifecycle step, read off the one lifecycle table
// (work-claims CLAIM_LIFECYCLE) so this surface cannot drift from the
// verbs the update route actually accepts. A delivered claim has no
// owner-forward verb: the step belongs to its reviewers.
function ownerNextAction(item) {
  const row = CLAIM_LIFECYCLE[item.state] ?? {};
  if (Object.hasOwn(row, "start")) return "start";
  if (Object.hasOwn(row, "finish")) return "finish";
  if (item.state === "delivered") return "await_review";
  return null;
}

// A changes-requested verdict that still asks the CURRENT owner for work:
// recorded against this ownership round (same owner + claimedAt as the live
// claim) and, when both carry it, the live delivery generation. A verdict
// from a released/re-claimed round or an earlier delivery is history.
function changesRequestedOf(item) {
  let latest = null;
  for (const review of item.reviews ?? []) {
    if (review?.verdict !== "changes_requested") continue;
    const basis = review.basis;
    if (!basis || basis.owner !== item.owner || basis.claimedAt !== item.claimedAt) continue;
    if (Number.isSafeInteger(basis.deliveryGeneration) && Number.isSafeInteger(item.deliveryGeneration)
      && basis.deliveryGeneration !== item.deliveryGeneration) continue;
    if (!latest || String(review.at ?? "") > String(latest.at ?? "")) latest = review;
  }
  return latest;
}

// Every open claim this member owns, with state and next step (agent-inbox
// v1). myWork above flags only the two urgent cases (lease expiring, idle);
// an agent planning its turn needs the full list without re-reading the
// board. Standing state like openWork: never moves the cursor. The filter
// is ownership within rooms the identity already belongs to, so it exposes
// nothing the member could not already see on that room's Board.
export function myClaimsOf(store, roomId, memberId, claims = null) {
  const list = claims ?? claimBoardOf(store, roomId);
  if (!list) return null;
  const nowMs = typeof store.now === "function" ? store.now() : Date.now();
  const mine = list.filter(item => item && item.owner === memberId && MY_CLAIM_STATES.has(item.state) && !item.supersededBy);
  if (!mine.length) return null;
  const rank = { blocked: 0, in_progress: 1, claimed: 2, delivered: 3 };
  mine.sort((a, b) => rank[a.state] - rank[b.state]
    || String(claimUpdatedAt(b) ?? "").localeCompare(String(claimUpdatedAt(a) ?? ""))
    || String(a.id).localeCompare(String(b.id)));
  const byState = {};
  for (const item of mine) byState[item.state] = (byState[item.state] ?? 0) + 1;
  return {
    roomId,
    count: mine.length,
    byState,
    top: mine.slice(0, MY_CLAIMS_SHOWN).map(item => ({
      id: item.id,
      title: String(item.title ?? "").slice(0, OPEN_WORK_TITLE),
      ...snippetField(item),
      state: item.state,
      next: ownerNextAction(item),
      ...(item.leaseExpiresAt ? { leaseExpiresAt: item.leaseExpiresAt } : {}),
      // #3753: the same leaseLapsed fact the board and single-claim read
      // stamp — a delivery waiting past its lease says so in the inbox.
      ...(deliveryLeaseLapsed(item, nowMs) ? { leaseLapsed: true } : {}),
      ...(item.pullRequest?.url ? { pullRequest: item.pullRequest.url } : {}),
      ...(item.ci?.state ? { ci: item.ci.state } : {}),
      ...(changesRequestedOf(item) ? { changesRequested: true } : {})
    })),
    next: `GET /api/rooms/${encodeURIComponent(roomId)}/work-claims`
  };
}

// Needed actions on work this member owns (agent-inbox v1): the claim's
// recorded CI rollup failed, or a reviewer asked for changes on the current
// delivery. Both already wake the owner once (work-claim-events); this is
// the standing state a polling agent can re-read after a missed wake,
// instead of re-reading the board to find what is broken. PR checks for
// work NOT linked to a room claim have no in-room record and are out of
// scope here — the land-queue items above carry their own checks_state.
export function actionsNeededOf(store, roomId, memberId, claims = null) {
  const list = claims ?? claimBoardOf(store, roomId);
  if (!list) return null;
  const rows = [];
  for (const item of list) {
    if (!item || item.owner !== memberId || item.supersededBy || !MY_CLAIM_STATES.has(item.state)) continue;
    const title = String(item.title ?? "").slice(0, OPEN_WORK_TITLE);
    const at = claimUpdatedAt(item) ?? "";
    if (item.ci?.state === "failure") {
      rows.push({
        id: item.id, title, ...snippetField(item), why: "ci_failed", at,
        ...(item.ci.url ? { ciUrl: item.ci.url } : {}),
        ...(item.ci.headSha ? { headSha: item.ci.headSha } : {}),
        ...(item.pullRequest?.url ? { pullRequest: item.pullRequest.url } : {})
      });
    }
    const changes = changesRequestedOf(item);
    if (changes) {
      rows.push({
        id: item.id, title, why: "changes_requested", at,
        by: changes.memberId,
        summary: clip(changes.summary)
      });
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(a.id).localeCompare(String(b.id)));
  return {
    roomId,
    count: rows.length,
    top: rows.slice(0, ACTIONS_NEEDED_SHOWN).map(({ at, ...row }) => row),
    next: `GET /api/rooms/${encodeURIComponent(roomId)}/work-claims`
  };
}

export function collectNeedsMe(store, secret, { since } = {}) {
  let identity = null;
  let allowedRooms = null;
  if (typeof secret === "string" && secret.startsWith("rak_")) {
    const record = store.agentPlugin.verifyPresentedApiKey(secret);
    if (!record) fail(401, "unauthenticated", "Unknown, revoked, or expired API key");
    allowedRooms = record.scopes.filter(scope => scope.startsWith("mcp:room:")).map(scope => scope.slice("mcp:room:".length));
    if (allowedRooms.length === 0) fail(403, "insufficient_scope", "This key is limited to its room");
    const row = store.identities.get(record.identityId);
    if (!row) fail(401, "unauthenticated", "Unknown or revoked identity credential");
    identity = { identityId: row.identityId, displayName: row.displayName };
  } else {
    identity = store.identities.resolveGlobalIdentitySecret(secret);
  }
  if (!identity) fail(401, "unauthenticated", "Unknown or revoked identity secret");
  const parsed = parseNeedsMeSince(since);
  // Seats come from the shared resolver (#3882): identity_links plus
  // guest_members trial seats — a guest seat's room belongs in the inbox
  // with the same membership truth as everywhere else. archivedAt rides
  // from the rooms row; a seat whose room row is gone reads as archived
  // (the old INNER JOIN dropped it the same way).
  const seats = identityRoomSeats(store.db, identity.identityId,
    { after: parsed.roomAfter ?? "", limit: MAX_ROOMS + 1 });
  const roomRows = seats.length ? store.db.prepare(
    `SELECT id, archived_at AS archivedAt FROM rooms WHERE id IN (${seats.map(() => "?").join(",")})`
  ).all(...seats.map(seat => seat.roomId)) : [];
  const archivedByRoom = new Map(roomRows.map(row => [row.id, row.archivedAt]));
  const links = seats.map(seat => ({
    ...seat,
    archivedAt: archivedByRoom.has(seat.roomId) ? archivedByRoom.get(seat.roomId) : 1
  }));
  const items = [];
  const rooms = { ...parsed.rooms };
  const land = { ...parsed.land };
  const landIds = { ...parsed.landIds };
  const pendingBonds = store.bonds.pendingProposalsFor(identity.identityId);
  const openWork = [];
  const reviewAsks = [];
  const myWork = [];
  const myClaims = [];
  const actionsNeeded = [];
  let roomAfter = parsed.roomAfter ?? "";
  let hasMore = links.length > MAX_ROOMS;
  for (const link of links.slice(0, MAX_ROOMS)) {
    if (allowedRooms && !allowedRooms.includes(link.roomId)) { roomAfter = link.roomId; continue; }
    if (link.archivedAt) { roomAfter = link.roomId; continue; }
    // Do not silently acknowledge a room whose authority/projection failed.
    const authority = store.roomAuthority(link.roomId);
    const member = authority.members?.[link.memberId];
    if (!member || member.active === false) { roomAfter = link.roomId; continue; }
    // One summary per room this page walks (at most MAX_ROOMS), none dropped.
    // One claim-board read for the three work sections below; they used to
    // each re-list and re-decode the whole board (see claimBoardOf).
    const claims = claimBoardOf(store, link.roomId);
    const open = openWorkOf(store, link.roomId, link.memberId, authority, claims);
    if (open) openWork.push(open);
    const asks = reviewAsksOf(store, link.roomId, link.memberId, authority, claims);
    if (asks) reviewAsks.push(asks);
    const mine = myWorkOf(store, link.roomId, link.memberId, claims);
    if (mine) myWork.push(mine);
    const owned = myClaimsOf(store, link.roomId, link.memberId, claims);
    if (owned) myClaims.push(owned);
    const needed = actionsNeededOf(store, link.roomId, link.memberId, claims);
    if (needed) actionsNeeded.push(needed);
    // A watermark above the room head (a numeric since taken from another
    // room's seq, or a cursor saved before a restore) can never be passed
    // legitimately; keeping it would hide this room's next events.
    const after = Math.min(roomWatermark(parsed, link.roomId), authority.sequence);
    const landAfter = landWatermark(parsed, link.roomId);
    let through = mentionHorizon(store, link.roomId, link.memberId, after, sessionWatermark(after, authority.sequence));
    let candidates = [];
    if (authority.sequence > after) {
      const state = store.room(link.roomId).state;
      const kinds = [
        mentionsOf(store, link.roomId, link.memberId, after, through),
        roomDmsOf(store, link.roomId, link.memberId, after, state),
        peerDmsOf(store, link.roomId, identity.identityId, after),
        bondRequestsOf(store, link.roomId, pendingBonds, after),
        directAsksOf(store, link.roomId, link.memberId, after, state),
        handoffsOf(store, link.roomId, link.memberId, after, state)
      ];
      for (const kind of kinds) {
        if (kind.length > MAX_PER_KIND) through = Math.min(through, kind[MAX_PER_KIND].seq - 1);
        for (const item of kind) push(candidates, item);
      }
      const retired = retiredNeedsMeKeys(store, link.roomId, link.memberId);
      candidates = candidates.filter(item => item.seq <= through && !retired.has(`${item.kind}:${item.id}`)).sort((a, b) => a.seq - b.seq);
      const remaining = MAX_ITEMS - items.length;
      if (candidates.length > remaining) {
        through = Math.min(through, candidates[remaining].seq - 1);
        candidates = candidates.filter(item => item.seq <= through);
      }
      items.push(...candidates);
    }
    rooms[link.roomId] = through;
    const changes = landChangesOf(store, link.roomId, link.memberId, landAfter, landIds[link.roomId]);
    const selected = changes.slice(0, Math.min(MAX_PER_KIND, MAX_ITEMS - items.length));
    items.push(...selected);
    if (selected.length) {
      const last = selected.at(-1);
      land[link.roomId] = last.seq;
      landIds[link.roomId] = last.id;
    } else if (!changes.length) {
      land[link.roomId] = landAfter;
    }
    const pending = through < authority.sequence || selected.length < changes.length;
    if (pending) { hasMore = true; break; }
    roomAfter = link.roomId;
    if (items.length === MAX_ITEMS && link !== links.at(-1)) { hasMore = true; break; }
  }
  // Retain the old rooms/land shape and extend it only for continuation/ties.
  // r216 (John's Tab QA): a legacy numeric floor must ride only while the read
  // is still paginating (hasMore). Once a pass records every linked room, the
  // floor would follow the agent into a room it joins later and hide that
  // room's first mentions forever; without it, cursor.rooms/landIds keep the
  // delivered state exact and nothing replays.
  const cursor = { rooms, land, landIds, ...(parsed.number !== null && hasMore ? { floor: parsed.number } : {}), ...(hasMore ? { roomAfter } : {}) };
  items.sort((a, b) => a.roomId.localeCompare(b.roomId) || b.seq - a.seq);
  // R327-1 (r6): tell a paused agent it is paused. Items stay readable (this
  // is a read surface) but carry paused:true; `paused` names each paused room
  // and who holds the pause.
  const pausedRooms = store.agentHeartbeats?.pausedRoomsOf?.(identity.identityId)?.filter(p => !allowedRooms || allowedRooms.includes(p.roomId)) ?? [];
  if (pausedRooms.length) {
    const held = new Set(pausedRooms.map(p => p.roomId));
    for (let i = 0; i < items.length; i++) if (held.has(items[i]?.roomId)) items[i] = { ...items[i], paused: true };
  }
  return { identityId: identity.identityId, items, ...(pausedRooms.length ? { paused: pausedRooms } : {}), ...(openWork.length ? { openWork } : {}), ...(reviewAsks.length ? { reviewAsks } : {}), ...(myWork.length ? { myWork } : {}), ...(myClaims.length ? { myClaims } : {}), ...(actionsNeeded.length ? { actionsNeeded } : {}), cursor, hasMore, untrusted: true };
}
