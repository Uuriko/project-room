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

import { ServiceError } from "./store.mjs";
import { nextWorkStep } from "../src/workflow.js";

const MAX_ROOMS = 40;
const MAX_PER_KIND = 8;
const MAX_ITEMS = 100;

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
    return { provided: true, number: null, rooms, land };
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

function mentionsOf(store, roomId, memberId, after) {
  let rows;
  try { rows = store.openDirectMentions(roomId, memberId, MAX_PER_KIND); }
  catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return [];
    throw error;
  }
  return rows.filter(row => row.sequence > after).slice(0, MAX_PER_KIND).map(row => ({
    kind: "mention",
    roomId,
    seq: row.sequence,
    id: row.messageId ?? row.eventId,
    summary: clip(row.body),
    next: {
      tool: "room_reply",
      arguments: {
        roomId,
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
    if (items.length >= MAX_PER_KIND) break;
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
  return items;
}

function handoffsOf(store, roomId, memberId, after, state) {
  const items = [];
  for (const item of Object.values(state.workItems ?? {})) {
    if (items.length >= MAX_PER_KIND) break;
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
  return items;
}

function roomDmsOf(store, roomId, memberId, after) {
  const rows = store.db.prepare(
    `SELECT sequence, body FROM events
     WHERE room_id=? AND sequence>? AND json_extract(body,'$.type')='message.posted'
       AND json_extract(body,'$.data.toMemberId')=?
     ORDER BY sequence DESC LIMIT ?`
  ).all(roomId, after, memberId, MAX_PER_KIND);
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
        arguments: { roomId, replyToId: messageId, ...(event.actorId ? { toMemberId: event.actorId } : {}) }
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
     ORDER BY e.sequence DESC LIMIT ?`
  ).all(identityId, roomId, after, MAX_PER_KIND);
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
    if (items.length >= MAX_PER_KIND) break;
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
  return items;
}

function landChangesOf(store, roomId, memberId, after) {
  let rows;
  try {
    rows = store.db.prepare(
      `SELECT item_id, repo, pr_number, updated_at, title, checks_state
       FROM land_queue
       WHERE room_id=? AND claimant_member_id=? AND updated_at>?
         AND (observed=1 OR updated_at>created_at)
       ORDER BY updated_at DESC LIMIT ?`
    ).all(roomId, memberId, after, MAX_PER_KIND);
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

function landCursor(store, roomId, memberId) {
  try {
    return store.db.prepare(
      "SELECT MAX(updated_at) AS n FROM land_queue WHERE room_id=? AND claimant_member_id=?"
    ).get(roomId, memberId)?.n ?? 0;
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return 0;
    throw error;
  }
}

export function collectNeedsMe(store, secret, { since } = {}) {
  const identity = store.identities.resolveGlobalIdentitySecret(secret);
  if (!identity) fail(401, "unauthenticated", "Unknown or revoked identity secret");
  const parsed = parseNeedsMeSince(since);
  const links = store.db.prepare(
    `SELECT l.room_id AS roomId, l.member_id AS memberId, r.sequence AS sequence, r.archived_at AS archivedAt
     FROM identity_links l JOIN rooms r ON r.id=l.room_id
     WHERE l.identity_id=?
     ORDER BY l.room_id
     LIMIT ?`
  ).all(identity.identityId, MAX_ROOMS);
  const items = [];
  const rooms = {};
  const land = {};
  const pendingBonds = store.bonds.pendingProposalsFor(identity.identityId);
  for (const link of links) {
    if (link.archivedAt) continue;
    let authority;
    try { authority = store.roomAuthority(link.roomId); }
    catch { continue; }
    const member = authority.members?.[link.memberId];
    if (!member || member.active === false) continue;
    const after = roomWatermark(parsed, link.roomId);
    const landAfter = landWatermark(parsed, link.roomId);
    rooms[link.roomId] = authority.sequence;
    land[link.roomId] = landCursor(store, link.roomId, link.memberId);
    const moved = authority.sequence > after;
    if (moved) {
      let state = null;
      const projection = () => {
        if (!state) state = store.room(link.roomId).state;
        return state;
      };
      for (const item of mentionsOf(store, link.roomId, link.memberId, after)) push(items, item);
      for (const item of roomDmsOf(store, link.roomId, link.memberId, after)) push(items, item);
      for (const item of peerDmsOf(store, link.roomId, identity.identityId, after)) push(items, item);
      for (const item of bondRequestsOf(store, link.roomId, pendingBonds, after)) push(items, item);
      try {
        for (const item of directAsksOf(store, link.roomId, link.memberId, after, projection())) push(items, item);
        for (const item of handoffsOf(store, link.roomId, link.memberId, after, projection())) push(items, item);
      } catch { /* a corrupt projection skips asks and handoffs for this room */ }
    }
    for (const item of landChangesOf(store, link.roomId, link.memberId, landAfter)) push(items, item);
  }
  items.sort((a, b) => a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : b.seq - a.seq);
  return {
    identityId: identity.identityId,
    items: items.slice(0, MAX_ITEMS),
    cursor: { rooms, land },
    untrusted: true
  };
}
