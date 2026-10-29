// room_since — cross-room, identity-scoped, enumerative delta read
// (ROOM-READS lane RR-D1, implementing the RS design,
// wave-2026-10-27-consult-build/lanes/RS/DESIGN.md §1-§2).
//
// One call replaces "list my rooms, digest each one, re-read needs-me,
// diff the boards myself" for an agent that was asleep: given the cursor
// from the previous call it returns everything that changed for this
// identity since then, in typed buckets — asks, messages, claims,
// decisions, plus landChanges inherited from needs-me — as fields, not
// prose. It is a pure delta: no standing sections, nothing repeats
// across polls, and the client-held cursor is the only state.
//
// Composition (RS §2): auth, asks/messages/landChanges and their
// handled-filter semantics are collectNeedsMe's, called first and never
// re-derived. The two journal buckets (decisions, claim changes) are
// enumerated here from the events journal with the query patterns of
// RoomStore.roomDigest, oldest-first, with exact whole-window totals in
// `coverage`. This module changes no behaviour of collectNeedsMe,
// /digest, or any existing caller, and edits no line of needs-me.mjs.
//
// SEQUENCE NOTE: the RS design hard-sequences this build behind
// #5125 (ATT bountyAttention) and #5137 (needs-me memoise). Both were
// still OPEN when this was built, so this PR is a DRAFT that must not
// land until both have merged and the §3 drift check is re-run against
// the post-ATT/NM needs-me.mjs. The composition tolerates ATT's known
// drift (an added top-level bountyAttention key is ignored here).
import { collectNeedsMe } from "./needs-me.mjs";
import { ServiceError } from "./store.mjs";
import { identityRoomSeats } from "./membership-resolution.mjs";
import { CLAIM_LIFECYCLE, releaseExpired } from "./work-claims.mjs";
import { withContentTrust } from "./content-trust.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const clip = text => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 140 ? `${value.slice(0, 139)}…` : value;
};
const title80 = value => String(value ?? "").slice(0, 80);

// Journal bucket caps (RS §1.5): paginate, never shed. Undelivered rows
// stop the watermark at the last delivered seq and set hasMore.
const PER_ROOM_CAP = 25;
const PER_BUCKET_CAP = 100;

const CURSOR_KEYS = new Set(["v", "needsMe", "decisions", "claims"]);

function integerMapStrict(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length < 1 || key.length > 128 || !Number.isSafeInteger(raw) || raw < 0) return null;
    out[key] = raw;
  }
  return out;
}

// Cursor shapes (RS §1.2/§1.3): omitted = bootstrap; 0 = genesis; a
// returned cursor object passed back unchanged. Anything else 422s.
function parseRoomSinceCursor(since) {
  if (since == null || since === "") return { mode: "bootstrap", needsMe: undefined, decisions: {}, claims: {} };
  if (since === 0 || since === "0") return { mode: "genesis", needsMe: 0, decisions: {}, claims: {} };
  let object = since;
  if (typeof object === "string") {
    try { object = JSON.parse(object.trim()); } catch { fail(422, "invalid_cursor", "since must be 0 or a returned room-since cursor object"); }
  }
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    fail(422, "invalid_cursor", "since must be 0 or a returned room-since cursor object");
  }
  for (const key of Object.keys(object)) {
    if (!CURSOR_KEYS.has(key)) fail(422, "invalid_cursor", `Unknown room-since cursor field: ${key}`);
  }
  if (object.v !== 1) fail(422, "invalid_cursor", "room-since cursor version must be 1");
  const decisions = integerMapStrict(object.decisions);
  const claims = integerMapStrict(object.claims);
  if (!decisions || !claims) fail(422, "invalid_cursor", "room-since cursor watermarks must be non-negative integers keyed by room id");
  return { mode: "cursor", needsMe: object.needsMe, decisions, claims };
}

// needs-me's claimBoardOf is private and the RS charter forbids editing
// needs-me.mjs in this build, so the same 3-line derivation is mirrored
// here: the durable registry list with lapsed leases released in-memory.
function claimBoardOf(store, roomId) {
  let list = null;
  try { list = store.workClaims?.list(roomId) ?? []; } catch { return null; }
  if (!list) return null;
  try { return releaseExpired(list, typeof store.now === "function" ? store.now() : Date.now()); }
  catch { return list; }
}

// Mirrors needs-me's private ownerNextAction: the owner's next lifecycle
// verb, read off the one CLAIM_LIFECYCLE table.
function ownerNextAction(item) {
  const row = CLAIM_LIFECYCLE[item.state] ?? {};
  if (Object.hasOwn(row, "start")) return "start";
  if (Object.hasOwn(row, "finish")) return "finish";
  if (item.state === "delivered") return "await_review";
  return null;
}

export function collectRoomSince(store, secret, { since, roomId: scopedRoom = null } = {}) {
  const parsed = parseRoomSinceCursor(since);
  // Auth + the needs-me buckets come from collectNeedsMe, first and
  // untouched: its 401/403/422 are this surface's (RS §2). Bootstrap is a
  // delta-surface notion, so the backlog walk is drained internally and
  // its items discarded — bootstrap pins the cursor, it does not dump
  // history (that stays needs-me's job).
  let needsMe;
  if (parsed.mode === "bootstrap") {
    needsMe = collectNeedsMe(store, secret, { roomId: scopedRoom ?? undefined });
    while (needsMe.hasMore) needsMe = collectNeedsMe(store, secret, { since: needsMe.cursor, roomId: scopedRoom ?? undefined });
  } else {
    needsMe = collectNeedsMe(store, secret, { since: parsed.needsMe, roomId: scopedRoom ?? undefined });
  }
  const identityId = needsMe.identityId;

  // A room-scoped rak_ key may only see its own rooms' journal buckets;
  // collectNeedsMe has already verified the key, so this read cannot 401.
  let allowedRooms = null;
  if (typeof secret === "string" && secret.startsWith("rak_")) {
    const record = store.agentPlugin.verifyPresentedApiKey(secret);
    allowedRooms = record.scopes.filter(scope => scope.startsWith("mcp:room:")).map(scope => scope.slice("mcp:room:".length));
  }

  // Split needs-me items into the delta buckets, verbatim, re-sorted to
  // this surface's (roomId asc, seq asc) order (RS §1.4/§1.5).
  const asks = [], messages = [], landChanges = [];
  const deliveredByRoom = new Map();
  for (const item of needsMe.items ?? []) {
    if (parsed.mode === "bootstrap") break;
    if (item.kind === "direct_ask" || item.kind === "handoff" || item.kind === "bond_request") asks.push(item);
    else if (item.kind === "mention" || item.kind === "dm") messages.push(item);
    else if (item.kind === "land_queue") landChanges.push(item);
    const counts = deliveredByRoom.get(item.roomId) ?? { asks: 0, messages: 0 };
    if (item.kind === "direct_ask" || item.kind === "handoff" || item.kind === "bond_request") counts.asks += 1;
    if (item.kind === "mention" || item.kind === "dm") counts.messages += 1;
    deliveredByRoom.set(item.roomId, counts);
  }
  const byRoomSeq = (a, b) => a.roomId.localeCompare(b.roomId) || a.seq - b.seq;
  asks.sort(byRoomSeq); messages.sort(byRoomSeq); landChanges.sort(byRoomSeq);

  // Journal buckets over the caller's seats (the shared resolver
  // collectNeedsMe uses), with per-room watermarks independent of the
  // needs-me sub-cursor and of each other (RS §1.3).
  const seats = identityRoomSeats(store.db, identityId, {});
  const seatRooms = new Set(seats.map(seat => seat.roomId));
  const archivedByRoom = new Map();
  if (seats.length) {
    const rows = store.db.prepare(
      `SELECT id, archived_at AS archivedAt FROM rooms WHERE id IN (${seats.map(() => "?").join(",")})`
    ).all(...seats.map(seat => seat.roomId));
    for (const row of rows) archivedByRoom.set(row.id, row.archivedAt);
  }
  const nextDecisions = parsed.mode === "cursor" ? { ...parsed.decisions } : {};
  const nextClaims = parsed.mode === "cursor" ? { ...parsed.claims } : {};
  const decisions = [], claims = [], coverage = [];
  const clampedRooms = [], floorApplied = [], droppedRooms = [];
  let journalHasMore = Boolean(needsMe.hasMore);
  let decisionsBudget = PER_BUCKET_CAP, claimsBudget = PER_BUCKET_CAP;

  const dropRoom = roomId => {
    if (Object.hasOwn(nextDecisions, roomId) || Object.hasOwn(nextClaims, roomId)) droppedRooms.push(roomId);
    delete nextDecisions[roomId]; delete nextClaims[roomId];
  };
  if (parsed.mode === "cursor") {
    for (const roomId of new Set([...Object.keys(parsed.decisions), ...Object.keys(parsed.claims)])) {
      if (!seatRooms.has(roomId)) dropRoom(roomId);
    }
  }

  for (const seat of seats) {
    const roomId = seat.roomId;
    if (scopedRoom !== null && roomId !== scopedRoom) continue;
    if (allowedRooms && !allowedRooms.includes(roomId)) continue;
    if (!archivedByRoom.has(roomId) || archivedByRoom.get(roomId)) { dropRoom(roomId); continue; }
    const authority = store.roomAuthority(roomId);
    const member = authority.members?.[seat.memberId];
    if (!member || member.active === false) { dropRoom(roomId); continue; }
    const head = authority.sequence;
    const floor = typeof store.historyFloor === "function" ? store.historyFloor(roomId, seat.memberId, head) : null;
    const floorStart = floor ? floor.sequence - 1 : 0;

    const windowFor = (watermarks, bucket) => {
      let start = parsed.mode === "bootstrap" ? head : parsed.mode === "genesis" ? 0 : watermarks[roomId] ?? 0;
      if (start > head) {
        start = head;
        if (!clampedRooms.includes(roomId)) clampedRooms.push(roomId);
      }
      if (start < floorStart) {
        start = floorStart;
        if (parsed.mode !== "bootstrap" && !floorApplied.some(row => row.roomId === roomId)) {
          floorApplied.push({ roomId, fromSeq: floor.sequence });
        }
      }
      return start;
    };

    // Decisions: every decision journal event in the window.
    const dFrom = windowFor(parsed.decisions, "decisions");
    const decisionsTotal = parsed.mode === "bootstrap" ? 0 : store.db.prepare(
      `SELECT COUNT(*) AS count FROM events WHERE room_id=? AND sequence>? AND sequence<=?
         AND json_extract(body,'$.type') IN ('decision.recorded','owner.decision_recorded')`
    ).get(roomId, dFrom, head).count;
    let dDelivered = 0;
    if (decisionsTotal > 0 && decisionsBudget > 0) {
      const rows = store.db.prepare(
        `SELECT sequence AS seq, json_extract(body,'$.id') AS eventId, json_extract(body,'$.type') AS type,
                json_extract(body,'$.actorId') AS actorId, json_extract(body,'$.at') AS at,
                json_extract(body,'$.data.statement') AS statement, json_extract(body,'$.data.reason') AS reason,
                json_extract(body,'$.data.sourceMessageId') AS sourceMessageId FROM events
         WHERE room_id=? AND sequence>? AND sequence<=?
           AND json_extract(body,'$.type') IN ('decision.recorded','owner.decision_recorded')
         ORDER BY sequence ASC LIMIT ?`
      ).all(roomId, dFrom, head, Math.min(PER_ROOM_CAP, decisionsBudget));
      for (const row of rows) {
        decisions.push({
          roomId, seq: row.seq, eventId: row.eventId, type: row.type, actorId: row.actorId, at: row.at,
          ...(row.statement ? { statement: clip(row.statement) } : {}),
          ...(row.reason ? { reason: clip(row.reason) } : {}),
          ...(row.sourceMessageId ? { sourceMessageId: row.sourceMessageId } : {}),
          untrusted: true
        });
      }
      dDelivered = rows.length;
      decisionsBudget -= rows.length;
    }
    if (parsed.mode === "bootstrap") nextDecisions[roomId] = head;
    else if (dDelivered >= decisionsTotal) nextDecisions[roomId] = head;
    else { nextDecisions[roomId] = decisions.at(-1)?.roomId === roomId ? decisions.at(-1).seq : (parsed.decisions[roomId] ?? 0); journalHasMore = true; }

    // Claims: latest change per claim in the window, current owner only,
    // enriched from the current board (RS §2: myClaimsOf field semantics).
    const cFrom = windowFor(parsed.claims, "claims");
    let claimsChangedTotal = 0, cDelivered = 0;
    if (parsed.mode !== "bootstrap") {
      const changed = store.db.prepare(
        `SELECT sequence AS seq, json_extract(body,'$.data.workClaim') AS claimId,
                json_extract(body,'$.data.action') AS action, json_extract(body,'$.data.claimState') AS state,
                json_extract(body,'$.data.title') AS title FROM events
         WHERE room_id=? AND sequence>? AND sequence<=? AND json_extract(body,'$.type')='work_claim.updated'
           AND json_extract(body,'$.data.workClaim') IS NOT NULL
         ORDER BY sequence ASC`
      ).all(roomId, cFrom, head);
      const latest = new Map();
      for (const row of changed) latest.set(row.claimId, row);
      const board = claimBoardOf(store, roomId) ?? [];
      const boardById = new Map(board.filter(item => item && item.id).map(item => [item.id, item]));
      const mine = [...latest.values()]
        .filter(row => { const item = boardById.get(row.claimId); return item && item.owner === seat.memberId && !item.supersededBy; })
        .sort((a, b) => a.seq - b.seq);
      claimsChangedTotal = mine.length;
      const deliverable = mine.slice(0, Math.min(PER_ROOM_CAP, claimsBudget));
      for (const row of deliverable) {
        const item = boardById.get(row.claimId);
        claims.push({
          roomId, seq: row.seq, id: row.claimId, title: title80(item.title ?? row.title), action: row.action, state: row.state,
          next: ownerNextAction(item),
          ...(item.pullRequest?.url ? { pullRequest: item.pullRequest.url } : {}),
          ...(item.ci?.state ? { ci: item.ci.state } : {}),
          ...(item.leaseExpiresAt ? { leaseExpiresAt: item.leaseExpiresAt } : {}),
          untrusted: true
        });
      }
      cDelivered = deliverable.length;
      claimsBudget -= cDelivered;
      void cDelivered;
    }
    if (parsed.mode === "bootstrap") nextClaims[roomId] = head;
    else if (claimsChangedTotal === 0 || claims.filter(row => row.roomId === roomId).length >= claimsChangedTotal) nextClaims[roomId] = head;
    else {
      const deliveredHere = claims.filter(row => row.roomId === roomId);
      nextClaims[roomId] = deliveredHere.length ? deliveredHere.at(-1).seq : (parsed.claims[roomId] ?? 0);
      journalHasMore = true;
    }

    const delivered = deliveredByRoom.get(roomId) ?? { asks: 0, messages: 0 };
    coverage.push({
      roomId, fromSeq: Math.min(dFrom, cFrom), toSeq: head,
      decisionsTotal, claimsChangedTotal,
      asksDelivered: delivered.asks, messagesDelivered: delivered.messages
    });
  }

  decisions.sort(byRoomSeq); claims.sort(byRoomSeq);
  const nowMs = typeof store.now === "function" ? store.now() : Date.now();
  return withContentTrust({
    contractVersion: 1,
    identityId,
    evaluatedAt: new Date(nowMs).toISOString(),
    ...(parsed.mode === "bootstrap" ? { bootstrapped: true } : {}),
    untrusted: true,
    asks, messages, claims, decisions, landChanges,
    coverage,
    ...(clampedRooms.length ? { clampedRooms } : {}),
    ...(floorApplied.length ? { floorApplied } : {}),
    ...(droppedRooms.length ? { droppedRooms } : {}),
    cursor: { v: 1, needsMe: needsMe.cursor, decisions: nextDecisions, claims: nextClaims },
    hasMore: journalHasMore
  });
}
