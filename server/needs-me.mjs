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
// numeric floor. Answered, handled, and cleared updates leave this list even
// when the caller does not pass a cursor.

import { ServiceError } from "./store.mjs";
import { nextWorkStep } from "../src/workflow.js";
import { retiredNeedsMeKeys } from "./updates.mjs";
import { mayWriteWorkClaims } from "./work-claim-routes.mjs";
import { claimUpdatedAt } from "./work-claims.mjs";

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
  // One query per chunk, not one per bond: the per-bond lookup has no index on
  // the bondId extract, so each bond costs a full scan of the room's events.
  // GROUP BY returns the same latest (MAX) sequence per bondId.
  const seqByBond = new Map();
  for (let i = 0; i < mine.length; i += 900) {
    const chunk = mine.slice(i, i + 900);
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

// The cursor acknowledges discovery, not completion. Only advance through
// sequence groups returned in full; multiple attention kinds may share an event.
export function openWorkOf(store, roomId, memberId, authority, nowMs = Date.now()) {
  const member = authority?.members?.[memberId];
  const ownerId = typeof authority?.ownerId === "string" && authority.ownerId ? authority.ownerId : null;
  if (!member || !mayWriteWorkClaims({ member: { ...member, id: memberId }, ownerId })) return null;
  let list;
  try { list = store.workClaims?.list(roomId) ?? []; } catch { return null; }
  const done = new Set(list.filter(item => item?.state === "done").map(item => item.id));
  const updatedMs = item => {
    const ms = Date.parse(claimUpdatedAt(item));
    return Number.isFinite(ms) ? ms : null;
  };
  // Sort on the exact timestamp; round to minutes only for display.
  const minutesSince = ms => (ms === null ? null : Math.max(0, Math.round((nowMs - ms) / 60000)));
  // Board order (updatedAt desc, then id) within each group, as the Board shows.
  const ready = list.filter(item => item?.state === "unclaimed" && (item.kind ?? "work") === "work"
    && (item.dependsOn ?? []).every(dep => done.has(dep)))
    .map(item => ({ item, at: updatedMs(item), released: (item.history ?? []).some(entry => entry?.action === "claimed") }))
    // Work posted for pickup (never claimed) first; released or lease-expired
    // items can be finished work handed back without "done", so they follow.
    .sort((a, b) => Number(a.released) - Number(b.released)
      || (b.at ?? -Infinity) - (a.at ?? -Infinity) || String(a.item.id).localeCompare(String(b.item.id)))
    .map(row => ({ ...row, idleMinutes: minutesSince(row.at) }));
  if (!ready.length) return null;
  const idles = ready.map(row => row.idleMinutes).filter(value => value !== null);
  return {
    roomId,
    count: ready.length,
    neverClaimed: ready.filter(row => !row.released).length,
    ...(idles.length ? { oldestIdleMinutes: Math.max(...idles) } : {}),
    top: ready.slice(0, OPEN_WORK_SHOWN).map(({ item, idleMinutes, released }) => ({
      id: item.id,
      title: String(item.title ?? "").slice(0, OPEN_WORK_TITLE),
      ...(idleMinutes !== null ? { idleMinutes } : {}),
      ...(released ? { released: true } : {}),
      ...(item.tags?.length ? { tags: item.tags.slice(0, 3) } : {})
    })),
    next: `POST /api/rooms/${encodeURIComponent(roomId)}/work-claims/{id}/claim`
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
  const openWork = [];
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
    const open = openWorkOf(store, link.roomId, link.memberId, authority);
    if (open) openWork.push(open);
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
  const cursor = { rooms, land, landIds, ...(parsed.number !== null ? { floor: parsed.number } : {}), ...(hasMore ? { roomAfter } : {}) };
  items.sort((a, b) => a.roomId.localeCompare(b.roomId) || b.seq - a.seq);
  return { identityId: identity.identityId, items, ...(openWork.length ? { openWork } : {}), cursor, hasMore, untrusted: true };
}
