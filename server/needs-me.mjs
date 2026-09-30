// Cross-room "what needs me" for one identity.
//
// One read replaces listing rooms and then opening each inbox. Items are
// mentions, direct reply asks, open handoffs, unread DMs, bond requests,
// and land-queue rows this member owns that have changed. Each item carries
// roomId, a seq cursor, and a suggested next tool call.
//
// since is a sequence number (applied per room) or the previous cursor
// { rooms: { roomId: seq }, land: { roomId: updatedAt } }. Land-queue
// changes do not advance the room sequence, so they use updated_at.
// Pass cursor back unchanged while hasMore is true, even for an empty page.
// Continuation adds roomAfter, landIds (timestamp tie breakers), and an optional
// numeric floor. Reading discovers items; it never acknowledges or resolves them.

import { ServiceError } from "./store.mjs";
import { nextWorkStep } from "../src/workflow.js";

const MAX_ROOMS = 40;
const MAX_PER_KIND = 8;
const MAX_ITEMS = 100;
const MENTION_WINDOW = 100;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const clip = text => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 140 ? `${value.slice(0, 139)}…` : value;
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

function roomDmsOf(store, roomId, memberId, after) {
  const rows = store.db.prepare(
    `SELECT sequence, body FROM events
     WHERE room_id=? AND sequence>? AND json_extract(body,'$.type')='message.posted'
       AND json_extract(body,'$.data.toMemberId')=?
     ORDER BY sequence ASC LIMIT ?`
  ).all(roomId, after, memberId, MAX_PER_KIND + 1);
  return rows.map(row => {
    const event = JSON.parse(row.body);
    const messageId = event.data?.messageId ?? event.id;
    return {
      kind: "dm",
      roomId,
      seq: row.sequence,
      id: messageId,
      channel: "room",
      summary: clip(event.data?.body),
      next: {
        tool: "room_reply",
        arguments: { roomId, requestId: `needs-me-${roomId}-${messageId}`, replyToId: messageId, ...(event.actorId ? { toMemberId: event.actorId } : {}) }
      }
    };
  });
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
  const items = [];
  for (const bond of mine) {
    const seq = store.db.prepare(
      `SELECT sequence FROM events
       WHERE room_id=? AND json_extract(body,'$.type')='bond.proposed'
         AND json_extract(body,'$.data.bondId')=?
       ORDER BY sequence DESC LIMIT 1`
    ).get(roomId, bond.bondId)?.sequence ?? null;
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

// The cursor acknowledges discovery, not completion. Only advance through
// sequence groups returned in full; multiple attention kinds may share an event.
export function collectNeedsMe(store, secret, { since } = {}) {
  const identity = store.identities.resolveGlobalIdentitySecret(secret);
  if (!identity) fail(401, "unauthenticated", "Unknown or revoked identity secret");
  const parsed = parseNeedsMeSince(since);
  const links = store.db.prepare(
    `SELECT l.room_id AS roomId, l.member_id AS memberId, r.archived_at AS archivedAt
     FROM identity_links l JOIN rooms r ON r.id=l.room_id
     WHERE l.identity_id=? AND l.room_id>?
     ORDER BY l.room_id LIMIT ?`
  ).all(identity.identityId, parsed.roomAfter ?? "", MAX_ROOMS + 1);
  const items = [];
  const rooms = { ...parsed.rooms };
  const land = { ...parsed.land };
  const landIds = { ...parsed.landIds };
  const pendingBonds = store.bonds.pendingProposalsFor(identity.identityId);
  let roomAfter = parsed.roomAfter ?? "";
  let hasMore = links.length > MAX_ROOMS;
  for (const link of links.slice(0, MAX_ROOMS)) {
    if (link.archivedAt) { roomAfter = link.roomId; continue; }
    // Do not silently acknowledge a room whose authority/projection failed.
    const authority = store.roomAuthority(link.roomId);
    const member = authority.members?.[link.memberId];
    if (!member || member.active === false) { roomAfter = link.roomId; continue; }
    const after = roomWatermark(parsed, link.roomId);
    const landAfter = landWatermark(parsed, link.roomId);
    let through = mentionHorizon(store, link.roomId, link.memberId, after, Math.max(after, authority.sequence));
    let candidates = [];
    if (authority.sequence > after) {
      const state = store.room(link.roomId).state;
      const kinds = [
        mentionsOf(store, link.roomId, link.memberId, after, through),
        roomDmsOf(store, link.roomId, link.memberId, after),
        peerDmsOf(store, link.roomId, identity.identityId, after),
        bondRequestsOf(store, link.roomId, pendingBonds, after),
        directAsksOf(store, link.roomId, link.memberId, after, state),
        handoffsOf(store, link.roomId, link.memberId, after, state)
      ];
      for (const kind of kinds) {
        if (kind.length > MAX_PER_KIND) through = Math.min(through, kind[MAX_PER_KIND].seq - 1);
        for (const item of kind) push(candidates, item);
      }
      candidates = candidates.filter(item => item.seq <= through).sort((a, b) => a.seq - b.seq);
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
  const cursor = { rooms, land, landIds, ...(parsed.number !== null ? { floor: parsed.number } : {}), ...(hasMore ? { roomAfter } : {}) };
  items.sort((a, b) => a.roomId.localeCompare(b.roomId) || b.seq - a.seq);
  return { identityId: identity.identityId, items, cursor, hasMore, untrusted: true };
}
