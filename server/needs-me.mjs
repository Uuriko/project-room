import { messageRepository } from "./message-repository.mjs";
import { sessionWatermark } from "./read-cursor.mjs";
import { stampNeedsMe } from "./content-trust.mjs";
// Cross-room "what needs me" for one identity.
//
// One read replaces listing rooms and then opening each inbox. Items are
// mentions, replies to this member's own posts (conversation attention:
// an open-thread reply carrying no @mention of the member and no formal
// reply request), direct reply asks, open handoffs, unread DMs, bond
// requests, and land-queue rows this member owns that have changed. Each item carries
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
import { visibleSequenceHorizon } from "./history-visibility.mjs";
import { nextWorkStep } from "../src/workflow.js";
import { retiredNeedsMeKeys } from "./updates.mjs";
import { mayWriteWorkClaims } from "./work-claim-routes.mjs";
import { availableBoardRowsInRoom } from "./available-work.mjs";
import { claimUpdatedAt, isHardWork, releaseExpired, resolveNamedReviewers, hasCurrentReview, currentReviewOf, CLAIM_LIFECYCLE, ACTIVE_CLAIM_STATES } from "./work-claims.mjs";
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
// Scan budgets for the conversation-attention scans (W2-F9-CURE of
// RES-1538; Codex's source review, room seq 25038, found the first cut
// scanned full history per read). Each scan below walks an indexed
// cursor range in batches and examines at most its row budget per room
// per read: replies need only MAX_PER_KIND + 1 items, so 256 examined
// reply rows is ~28x the useful yield; the mention horizon must count
// up to MENTION_WINDOW eligible rows through dead-row runs, so 512
// examined mention rows gives 5x headroom over the author's 100-dead-row
// case before paging. A scan that stops at its budget reports
// exhausted=true with scannedThrough at the last examined sequence; the
// caller clamps the room horizon there, so the read's cursor never
// claims unscanned history and the caller's next read (hasMore=true)
// resumes exactly where the scan stopped — no skipped asks, and no
// silent truncation that looks complete.
//
// Round 2 (Codex's exact-SQL falsifier, room seq 25273): the first cure
// counted only rows its SQL returned, but the queries filtered inside
// SQLite (json_extract predicates under a LIMIT; a join the planner
// drove from the events range), so the VM still stepped over every
// event in the range — 9,059 VM instructions at 1k plain events growing
// to 90,059 at 10k with zero reply rows examined on paper (mentions:
// 11,354 → 110,354). Both scans now STEP the events primary-key range
// themselves, in bounded windows, and count every stepped row and its
// body bytes: the budgets bind at examined-row and byte boundaries, in
// the units the falsifier measures, whatever the room's event mix. The
// byte budgets bind only for rooms of very large events (at ordinary
// message sizes the row budget stops the scan first).
//
// Round 3 (Codex's Worker admission falsifier, room seq 25331): the
// round-2 stepper fetched a whole batch's bodies and only then counted
// them, so the byte budget bound AFTER transfer — 3 legal escaped
// events totalling 1,179,969B crossed into JS before the count stopped
// the scan, a single >1MiB imported event crossed whole (1,048,684B)
// under the at-least-one-row rule, and covered replies refetched
// overlapping batches after the candidate break (1,625 payload rows
// fetched for 256 reported examined). The scans now ADMIT before they
// fetch: a scalar prefix pass reads only (sequence, stored octet
// length) for the next window and admits the longest prefix that fits
// the remaining row and byte budgets; only admitted bodies are fetched
// (one contiguous range), and every fetched row is examined and
// charged — fetched and examined are the same rows again. A row that
// would cross the remaining byte budget stops the scan before its body
// moves (exhausted, scannedThrough at the last admitted row; the next
// read admits it under a fresh budget, so progress never stalls). A
// single event whose stored size exceeds the WHOLE byte budget can
// never be admitted by any read: when the walk reaches it, the scan
// refuses with a typed 503 storage_unavailable before its payload
// crosses and before the cursor passes it.
export const REPLY_SCAN_ROW_BUDGET = 256;
export const MENTION_SCAN_ROW_BUDGET = 512;
export const REPLY_SCAN_BYTE_BUDGET = 1_048_576;
export const MENTION_SCAN_BYTE_BUDGET = 1_048_576;
const REPLY_SCAN_BATCH = 64;
const MENTION_SCAN_BATCH = 128;

// Scalar prefix admission for one stepping window (round 3, above).
// Reads only (sequence, octet length) scalars for up to `want` events
// after `cursor`, admits the longest prefix fitting the scan's
// remaining byte budget, fetches exactly those bodies as one contiguous
// range, and charges scan.scannedRows / scan.scannedBytes for exactly
// the rows returned — the rows that crossed into JS are the rows the
// report counts. Returns { rows, rangeEnd, budgetStop }: rangeEnd when
// the window reached the end of (cursor, through] with every fetched
// row admitted; budgetStop when the next row would cross the remaining
// byte budget and was left unfetched. Throws the typed 503 when the
// next row to examine exceeds the whole byte budget (see above).
function admittedEvents(store, roomId, cursor, through, want, scan, byteBudget) {
  const scalars = store.db.prepare(
    `SELECT sequence, length(CAST(body AS BLOB)) AS octets FROM events
     WHERE room_id=? AND sequence>? AND sequence<=?
     ORDER BY sequence ASC LIMIT ?`
  ).all(roomId, cursor, through, want);
  if (!scalars.length) return { rows: [], rangeEnd: true, budgetStop: false };
  let admitted = 0;
  let budgetStop = false;
  for (const scalar of scalars) {
    if (scalar.octets > byteBudget) {
      fail(503, "storage_unavailable",
        `Event at sequence ${scalar.sequence} in room ${roomId} is larger than the attention scan byte budget; refusing before its payload is fetched`);
    }
    if (scan.scannedBytes + scalar.octets > byteBudget) { budgetStop = true; break; }
    scan.scannedBytes += scalar.octets;
    admitted += 1;
  }
  if (!admitted) return { rows: [], rangeEnd: false, budgetStop: true };
  const rows = store.db.prepare(
    `SELECT id, sequence, body FROM events
     WHERE room_id=? AND sequence>? AND sequence<=?
     ORDER BY sequence ASC`
  ).all(roomId, cursor, scalars[admitted - 1].sequence);
  scan.scannedRows += rows.length;
  return { rows, rangeEnd: !budgetStop && scalars.length < want, budgetStop };
}

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
export const claimSnippet = claim => {
  const criteria = Array.isArray(claim?.acceptanceCriteria) ? claim.acceptanceCriteria : [];
  const criterion = criteria.find(entry => typeof entry === "string" && entry.trim());
  if (criterion) return clip(criterion);
  const history = Array.isArray(claim?.history) ? claim.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    // Machine receipts (retention_ack's "retention-ack seen=1 …") are not
    // a human summary; skip them so the snippet never shows internal keys.
    if (history[index]?.action === "retention_ack") continue;
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

// A first read with no cursor starts near the head instead of seq 0. In
// muse-room (23.9k events) a cold room_needs_me returned 3-week-old mentions
// and took 110+ calls to reach today. Pass since: 0 to replay from the start.
export const NEEDS_ME_FRESH_WINDOW = 500;

function roomWatermark(parsed, roomId, head = 0, window = NEEDS_ME_FRESH_WINDOW) {
  if (!parsed.provided) return Math.max(0, head - window);
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

// Conversation attention (RES-1538, the reply-alert lane): an open-thread
// reply to a message this member authored, carrying no @mention of the
// member and no formal reply request. This selection cannot ride the
// mention_states reply row: trackMentions writes that row only when the
// parent author is an agent-kind member AND the parent is resident in the
// live projection at reply time, so a human-kind seat (and any parent the
// projection has shed) never surfaced — the reply was invisible here.
// Covered elsewhere and excluded here, so one message yields one item:
// DM replies (toMemberId set — the dm kind serves the recipient), formal
// reply requests addressed to this member (direct_ask), and replies an
// open mention row already surfaces (mention). The mention-covered check
// runs inside the scan loop so a covered reply never consumes one of the
// MAX_PER_KIND + 1 slots.
//
// Bounded scan (W2-F9-CURE, Codex seq 25038): the first cut built a Set
// of every message id the member ever authored (full history, no
// sequence bound) and then batch-looped reply events until the kind
// filled, with no through bound — a no-match room scanned its whole
// reply history on every inbox read. This cut asks the same question
// with indexed, normalized lookups instead: candidate replies come from
// the events primary-key cursor range (room_id, sequence) bounded by
// (after, through], exactly the roomDmsOf idiom, and each candidate's
// parent is resolved per candidate — the message repository's current
// record (live read index, else the messages table's (room_id,
// message_id) primary key), falling back to the posting event's own
// UNIQUE id lookup for a replyToId that names the event rather than the
// canonical message id. No history-sized structure is built: the only
// sets are the standing open-ask ids and a per-call parent memo bounded
// by the rows examined. The scan examines at most
// REPLY_SCAN_ROW_BUDGET rows; on exhaustion it reports
// { exhausted: true, scannedThrough } and the caller clamps the room
// horizon to scannedThrough, so continuation resumes mid-history
// instead of the read silently passing over unscanned replies.
//
// Round 2 (Codex seq 25273): the first cure's candidate query carried
// its type/replyToId tests as json_extract predicates under a LIMIT,
// so SQLite stepped every event in the range while the budget counted
// only the rows that passed the filter — the work grew with room size
// while the report said 0 examined. The scan now steps the range
// itself and applies the same tests per stepped row in JS: every row
// the VM touches is a row the scan counts, in rows and in body bytes.
function repliesOf(store, roomId, memberId, after, through, state) {
  const scan = { items: [], scannedRows: 0, scannedBytes: 0, scannedThrough: after, exhausted: false };
  if (!(through > after)) return scan;
  const askIds = new Set(Object.values(state.replyRequests ?? {})
    .filter(request => request?.recipientId === memberId && request.status === "open")
    .map(request => request.id));
  const coveredByMention = eventIds => {
    if (!eventIds.length) return new Set();
    try {
      const rows = store.db.prepare(
        `SELECT message_event_id AS eventId FROM mention_states
         WHERE room_id=? AND mentioned_member_id=? AND state IN ('delivered','acknowledged','timed_out')
           AND message_event_id IN (${eventIds.map(() => "?").join(",")})`
      ).all(roomId, memberId, ...eventIds);
      return new Set(rows.map(row => row.eventId));
    } catch (error) {
      if (/no such table/i.test(error?.message ?? "")) return new Set();
      throw error;
    }
  };
  const currentById = messageRepository(store, roomId, state);
  const parentMemo = new Map();
  const parentIsMine = replyToId => {
    if (!parentMemo.has(replyToId)) {
      const current = currentById.get(replyToId);
      let mine = current ? current.authorId === memberId : false;
      if (!current) {
        const posted = store.db.prepare(
          `SELECT json_extract(body,'$.type') AS type, json_extract(body,'$.actorId') AS actorId
           FROM events WHERE room_id=? AND id=?`
        ).get(roomId, replyToId);
        mine = posted?.type === "message.posted" && posted?.actorId === memberId;
      }
      parentMemo.set(replyToId, mine);
    }
    return parentMemo.get(replyToId);
  };
  const items = scan.items;
  let cursor = after;
  while (items.length <= MAX_PER_KIND) {
    if (scan.scannedRows >= REPLY_SCAN_ROW_BUDGET || scan.scannedBytes >= REPLY_SCAN_BYTE_BUDGET) {
      scan.exhausted = scan.scannedThrough < through;
      break;
    }
    const want = Math.min(REPLY_SCAN_BATCH, REPLY_SCAN_ROW_BUDGET - scan.scannedRows);
    // Round 3: admission precedes the payload fetch, and every fetched
    // row is examined below — the round-2 loop stopped examining a
    // fetched batch at the candidate break and then refetched the
    // unexamined tail under the next batch, so covered replies paid
    // the transfer again on every pass (1,625 payload rows fetched for
    // 256 reported examined, Codex seq 25331). Candidates are now
    // collected across the whole admitted batch; the kind cap binds
    // what is KEPT (the caller's overflow clamp owns the horizon), not
    // what is examined.
    const batch = admittedEvents(store, roomId, cursor, through, want, scan, REPLY_SCAN_BYTE_BUDGET);
    if (!batch.rows.length) {
      if (batch.budgetStop) scan.exhausted = scan.scannedThrough < through;
      break;
    }
    const parsed = [];
    for (const row of batch.rows) {
      cursor = row.sequence;
      scan.scannedThrough = row.sequence;
      let event = null;
      try { event = JSON.parse(row.body); } catch { event = null; }
      if (event && event.type === "message.posted" && event.actorId !== memberId
        && typeof event.data?.replyToId === "string" && event.data.replyToId
        && !event.data.toMemberId && parentIsMine(event.data.replyToId)) {
        parsed.push({ row, event });
      }
    }
    const covered = coveredByMention(parsed.map(({ row }) => row.id));
    for (const { row, event } of parsed) {
      if (covered.has(row.id)) continue;
      const messageId = event.data.messageId ?? row.id;
      if (askIds.has(messageId)) continue;
      const current = currentById.get(messageId);
      if (current?.deletedAt) continue;
      items.push({
        kind: "reply",
        roomId,
        seq: row.sequence,
        id: messageId,
        replyToId: event.data.replyToId,
        summary: clip(current ? current.body : event.data.body),
        next: {
          tool: "room_reply",
          arguments: { roomId, requestId: `needs-me-${roomId}-${messageId}`, replyToId: messageId }
        }
      });
      if (items.length > MAX_PER_KIND) break;
    }
    if (batch.budgetStop) { scan.exhausted = scan.scannedThrough < through; break; }
    if (batch.rangeEnd) break;
  }
  items.sort((a, b) => a.seq - b.seq);
  return scan;
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

// DM scan budgets: the same examined-row/byte discipline as the reply
// scan (DMs need only MAX_PER_KIND + 1 items, so 256 examined rows is
// the same ~28x headroom). Kept as separate constants so each scan's
// budget can move independently, as REPLY/MENTION already do.
export const DM_SCAN_ROW_BUDGET = 256;
export const DM_SCAN_BYTE_BUDGET = 1_048_576;
const DM_SCAN_BATCH = 64;

function roomDmsOf(store, roomId, memberId, after, through, state) {
  // The event log holds the body as originally posted; the live projection
  // (state.messages) is the current state. A DM deleted after posting must
  // not surface at all (its logged body is already scrubbed, so it showed
  // as an empty item inviting a reply to a tombstone), and an edited DM
  // must show its current body, not the pre-edit text. Messages missing
  // from the working set are resolved through normalized archived records.
  // Only genuinely absent legacy records fall back to the logged body.
  const currentById = messageRepository(store, roomId, state);
  const scan = { items: [], scannedRows: 0, scannedBytes: 0, scannedThrough: after, exhausted: false };
  if (!(through > after)) return scan;
  const items = scan.items;
  // Bounded scan: this read used to batch-loop a json_extract-filtered
  // query until the kind filled or the range ended — the same
  // LIMIT-after-filter shape the round-2 falsifier refuted for replies
  // (the VM stepped every event in the range: 9,096 instructions at
  // 1,008 plain events growing to 90,096 at 10,008, ~9 per event). It
  // now steps the (after, through] range through the same scalar prefix
  // admission as the reply and mention scans (round 3): every examined
  // row is counted in rows and bytes, a budget stop reports
  // { exhausted: true, scannedThrough } and the callers clamp their
  // window to scanned ground, and an event larger than the whole byte
  // budget refuses typed 503 before its payload is fetched. A deleted
  // DM still must not consume one of the MAX_PER_KIND + 1 slots, or the
  // caller's overflow check (kind length > MAX_PER_KIND lowers the
  // cursor horizon) would advance the cursor past live DMs that were
  // never returned — the selection below decides per examined row, so
  // deleted rows cost budget, never slots.
  let cursor = after;
  while (items.length <= MAX_PER_KIND) {
    if (scan.scannedRows >= DM_SCAN_ROW_BUDGET || scan.scannedBytes >= DM_SCAN_BYTE_BUDGET) {
      scan.exhausted = scan.scannedThrough < through;
      break;
    }
    const want = Math.min(DM_SCAN_BATCH, DM_SCAN_ROW_BUDGET - scan.scannedRows);
    const batch = admittedEvents(store, roomId, cursor, through, want, scan, DM_SCAN_BYTE_BUDGET);
    if (!batch.rows.length) {
      if (batch.budgetStop) scan.exhausted = scan.scannedThrough < through;
      break;
    }
    for (const row of batch.rows) {
      cursor = row.sequence;
      scan.scannedThrough = row.sequence;
      let event = null;
      try { event = JSON.parse(row.body); } catch { event = null; }
      if (!event || event.type !== "message.posted" || event.data?.toMemberId !== memberId) continue;
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
    if (batch.budgetStop) { scan.exhausted = scan.scannedThrough < through; break; }
    if (batch.rangeEnd) break;
  }
  return scan;
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

// The window counts only rows the selection can return (RES-1538).
// openDirectMentions discards deleted/redacted messages, private
// messages the member is not party to, and timed_out rows the member
// already answered or late-acknowledged. Counting those dead rows let
// them consume the whole window on a warm read: the read returned a
// window ending before live mentions newer than the caller's cursor,
// with the returned cursor ahead of the returned items and
// hasMore=true, and the live mentions surfaced only after paging
// through the dead backlog.
//
// Bounded scan (W2-F9-CURE, Codex seq 25038): the first cut pre-built
// two full-history id sets (every deleted/redacted message id; every
// reply target the member ever posted) and shipped them to SQLite as
// JSON on every read. This cut walks the mention_states_member index
// (room_id, mentioned_member_id, state) joined to the events primary
// key in batches and decides eligibility per row with the selection's
// own normalized checks: the current message record's deletedAt (set
// by both delete and redact) and the repository's hasReply, both served
// by the message repository (live read index, else the messages
// table's primary key), plus the mention_observations columns the join
// already carries. No history-sized set is built. The scan examines at
// most MENTION_SCAN_ROW_BUDGET rows; on exhaustion the horizon is the
// last examined sequence — never `through` — so the caller's cursor
// stops at scanned ground, hasMore stays true, and the next read
// resumes the count instead of skipping the unscanned rows.
//
// Round 2 (Codex seq 25273): the join above was planned with the events
// range as the driving side (the sequence range + ORDER BY win over
// the member index), so the VM stepped every event in the range and
// probed the mention tables per event — sparse mentions still cost
// ~11 VM instructions per room event. The scan now steps the events
// range itself, in bounded windows, and probes mention_states /
// mention_observations per stepped event by (room_id, message_event_id,
// mentioned_member_id): every row the VM touches is counted, in rows
// and body bytes, and the examined unit — events stepped — is the unit
// the falsifier measures. Eligibility is decided per probed mention
// row with exactly the checks the join version made, so WHAT counts
// toward the window is unchanged; only WHO walks the range changed.
// scannedRows for this scan therefore counts examined events (the
// pre-round-2 count of returned mention rows reported 0 in a room of
// plain posts while the VM walked all of them).
function mentionHorizon(store, roomId, memberId, after, through) {
  const scan = { horizon: through, scannedRows: 0, scannedBytes: 0, exhausted: false };
  if (!(through > after)) return scan;
  try {
    // Schemas from before the mention tables have no mentions to count:
    // the horizon is the range end, as the pre-cure read behaved there.
    const mentionTables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mention_states','mention_observations')"
    ).all();
    if (mentionTables.length < 2) return scan;
    const mentionStmt = store.db.prepare(
      `SELECT m.state AS state, m.timeout_at AS timeoutAt,
              o.acknowledged_at AS acknowledgedAt, o.late_acknowledged_at AS lateAcknowledgedAt
       FROM mention_states m
       LEFT JOIN mention_observations o ON o.room_id=m.room_id AND o.message_event_id=m.message_event_id
         AND o.mentioned_member_id=m.mentioned_member_id
       WHERE m.room_id=? AND m.message_event_id=? AND m.mentioned_member_id=?
         AND m.state IN ('delivered','acknowledged','timed_out')`
    );
    let currentById = null;
    const records = () => {
      if (!currentById) {
        try { currentById = messageRepository(store, roomId); }
        catch (error) {
          if (error?.code !== "room_not_found") throw error;
          currentById = { get: () => undefined, hasReply: () => false };
        }
      }
      return currentById;
    };
    const eligible = (eventRow, mention) => {
      let logged = null;
      try { logged = JSON.parse(eventRow.body); } catch { logged = null; }
      if (logged?.type !== "message.posted") return false;
      const toMemberId = logged.data?.toMemberId;
      if (toMemberId && toMemberId !== memberId && logged.actorId !== memberId) return false;
      const messageId = logged.data?.messageId ?? eventRow.id;
      if (records().get(messageId)?.deletedAt) return false;
      if (mention.state === "timed_out") {
        if (records().hasReply(memberId, messageId)) return false;
        if (mention.lateAcknowledgedAt != null) return false;
        if (mention.acknowledgedAt != null && mention.timeoutAt != null && mention.acknowledgedAt > mention.timeoutAt) return false;
      }
      return true;
    };
    let cursor = after;
    let eligibleCount = 0;
    let windowEnd = null;
    while (true) {
      if (scan.scannedRows >= MENTION_SCAN_ROW_BUDGET || scan.scannedBytes >= MENTION_SCAN_BYTE_BUDGET) {
        scan.exhausted = cursor < through;
        scan.horizon = scan.exhausted ? cursor : through;
        return scan;
      }
      const want = Math.min(MENTION_SCAN_BATCH, MENTION_SCAN_ROW_BUDGET - scan.scannedRows);
      // Round 3: the same scalar prefix admission as the reply scan —
      // a batch's bodies are fetched only after the batch is admitted
      // under the remaining budgets, and every fetched row is stepped
      // and charged below.
      const batch = admittedEvents(store, roomId, cursor, through, want, scan, MENTION_SCAN_BYTE_BUDGET);
      if (!batch.rows.length) {
        if (batch.budgetStop) {
          scan.exhausted = cursor < through;
          scan.horizon = scan.exhausted ? cursor : through;
        } else {
          scan.horizon = through;
        }
        return scan;
      }
      let decided = false;
      for (const row of batch.rows) {
        cursor = row.sequence;
        const mention = mentionStmt.get(roomId, row.id, memberId);
        if (mention && eligible(row, mention)) {
          eligibleCount += 1;
          if (eligibleCount === MENTION_WINDOW) windowEnd = row.sequence;
          if (eligibleCount > MENTION_WINDOW) { scan.horizon = windowEnd; decided = true; break; }
        }
      }
      if (decided) return scan;
      if (batch.budgetStop) {
        scan.exhausted = cursor < through;
        scan.horizon = scan.exhausted ? cursor : through;
        return scan;
      }
      if (batch.rangeEnd) { scan.horizon = through; return scan; }
    }
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return { ...scan, horizon: through, exhausted: false };
    throw error;
  }
}

// The per-room attention slice of collectNeedsMe, exported for the room
// digest (server/room-digest.mjs): the same kinds, the same 140-char clip,
// the same horizon and retired-mark rules, restricted to seq > after in one
// room. Items keep the collectNeedsMe shape ({ kind, roomId, seq, id,
// summary, next }); the digest strips `next` when it composes its rows.
//
// The slice also reports its attention coverage (round 3, Codex seq
// 25334): when a bounded scan stopped at its budget, the window was
// clamped to scanned ground internally, and a caller composing a
// catch-up read (the digest) used to advertise the room head as its
// cursor with an attention total of 0 — a visible reply beyond the
// clamp vanished with no marker. attentionThrough is the sequence the
// attention listing is complete through: the ground the scans actually
// evaluated, lowered by any per-kind overflow clamp — the clamps cap
// what is LISTED, and a listing stopped at a kind's cap is not
// complete past the clamped sequence (the digest listed 5 of an
// attention total of 8 with no marker, Codex seq 25449).
// attentionComplete is false exactly when a scan's budget or a
// per-kind overflow clamp stopped the listing short of the window's
// end. The digest propagates both; the scans themselves stay
// bounded — no full-history scan is restored.
export function roomAttentionSlice(store, roomId, memberId, identityId, after) {
  const authority = store.roomAuthority(roomId);
  const member = authority.members?.[memberId];
  if (!member || member.active === false) return { items: [], attentionThrough: after, attentionComplete: true };
  if (!(authority.sequence > after)) return { items: [], attentionThrough: after, attentionComplete: true };
  const state = store.room(roomId).state;
  const floor = store.historyFloor(roomId, memberId, authority.sequence);
  const messageAfter = Math.max(after, floor ? floor.sequence - 1 : 0);
  const horizonScan = mentionHorizon(store, roomId, memberId, messageAfter, sessionWatermark(after, authority.sequence));
  let through = horizonScan.horizon;
  // A budget-exhausted reply scan clamps the window to scanned ground,
  // the same rule the per-kind overflow clamp below applies.
  const replyScan = repliesOf(store, roomId, memberId, messageAfter, through, state);
  if (replyScan.exhausted) through = Math.min(through, replyScan.scannedThrough);
  const dmScan = roomDmsOf(store, roomId, memberId, messageAfter, through, state);
  if (dmScan.exhausted) through = Math.min(through, dmScan.scannedThrough);
  const scanThrough = through;
  const pendingBonds = identityId ? store.bonds.pendingProposalsFor(identityId) : [];
  const kinds = [
    mentionsOf(store, roomId, memberId, messageAfter, through),
    replyScan.items,
    dmScan.items,
    peerDmsOf(store, roomId, identityId, after),
    bondRequestsOf(store, roomId, pendingBonds, after),
    directAsksOf(store, roomId, memberId, messageAfter, state),
    handoffsOf(store, roomId, memberId, after, state)
  ];
  const candidates = [];
  for (const kind of kinds) {
    if (kind.length > MAX_PER_KIND) through = Math.min(through, kind[MAX_PER_KIND].seq - 1);
    for (const item of kind) push(candidates, item);
  }
  // Coverage reports the ground the listing is complete through: an
  // engaged per-kind overflow clamp lowers it below scanThrough, and
  // the slice is incomplete exactly then (or when a scan budget
  // stopped it) — never silently (see the header note).
  const attentionThrough = through;
  const attentionComplete = !horizonScan.exhausted && !replyScan.exhausted && !dmScan.exhausted && through === scanThrough;
  const retired = retiredNeedsMeKeys(store, roomId, memberId);
  const items = candidates
    .filter(item => item.seq <= through && !retired.has(`${item.kind}:${item.id}`))
    .sort((a, b) => a.seq - b.seq);
  return { items, attentionThrough, attentionComplete };
}

export function roomAttention(store, roomId, memberId, identityId, after) {
  return roomAttentionSlice(store, roomId, memberId, identityId, after).items;
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
  const ready = availableBoardRowsInRoom(store, roomId, list)
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
// as reviewer (tag rev-<memberId>) and are ready to review (in_progress, a
// linked PR, or delivered — the state whose entire meaning is "awaiting a
// verdict"; excluding it emptied the named reviewer's queue at exactly the
// delivery transition, B-SURFACES F1 / X3 cell 5). Standing state like
// openWork: it never moves the cursor, and it returns when the head moves.
// Before delivery a recorded review on the current basis retires the ask,
// as before. Once delivered, a verdict alone does NOT retire it: recording
// a review is only the first of the two reviewer steps the update route
// enforces, so the ask stays and its per-item `next` advances to the
// state-moving call that completes the review (approve -> update
// {state:"done"}; changes_requested -> update {state:"in_progress"}).
// The ask retires only when the claim itself leaves `delivered` (done, or
// back in_progress after a send-back), so the queue cannot read "handled"
// while the work is neither accepted nor returned (B-SURFACES F2).
export function reviewAsksOf(store, roomId, memberId, authority, claims = null) {
  const list = claims ?? claimBoardOf(store, roomId);
  if (!list) return null;
  const phaseOf = item => {
    if (item.state !== "delivered") return hasCurrentReview(item, memberId) ? null : "review";
    const verdict = currentReviewOf(item, memberId)?.verdict;
    if (verdict === "approve") return "complete";
    if (verdict === "changes_requested") return "send_back";
    return "review";
  };
  const asks = list.filter(item => item && item.state !== "done" && !item.supersededBy && item.owner && item.owner !== memberId
      && resolveNamedReviewers(item, authority?.members).includes(memberId)
      && (item.state === "in_progress" || item.state === "delivered" || item.pullRequest || (item.pullRequests ?? []).length)
      && phaseOf(item) !== null)
    .sort((a, b) => String(claimUpdatedAt(b) ?? "").localeCompare(String(claimUpdatedAt(a) ?? "")) || String(a.id).localeCompare(String(b.id)));
  if (!asks.length) return null;
  const claimPath = id => `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(id)}`;
  return {
    roomId,
    count: asks.length,
    top: asks.slice(0, OPEN_WORK_SHOWN).map(item => {
      const phase = phaseOf(item);
      return {
        id: item.id,
        title: String(item.title ?? "").slice(0, OPEN_WORK_TITLE),
        ...snippetField(item),
        owner: item.owner,
        state: item.state,
        phase,
        ...(phase === "complete"
          ? { next: `POST ${claimPath(item.id)}/update`, nextBody: { state: "done" } }
          : phase === "send_back"
            ? { next: `POST ${claimPath(item.id)}/update`, nextBody: { state: "in_progress" } }
            : { next: `POST ${claimPath(item.id)}/review` }),
        ...(item.pullRequest?.url ? { pullRequest: item.pullRequest.url } : {}),
        ...(item.ci?.headSha ? { headSha: item.ci.headSha } : {}),
        ...(item.revision ? { revision: item.revision } : {})
      };
    }),
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

export function collectNeedsMe(store, secret, { since, roomId: scopedRoom = null, freshWindow = NEEDS_ME_FRESH_WINDOW } = {}) {
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
  if (scopedRoom !== null && (typeof scopedRoom !== "string" || !scopedRoom))
    fail(422, "invalid_room", "roomId must be a non-empty string");
  if (scopedRoom !== null && allowedRooms && !allowedRooms.includes(scopedRoom))
    fail(403, "insufficient_scope", "This key is limited to its room");
  // Seats come from the shared resolver (#3882): identity_links plus
  // guest_members trial seats — a guest seat's room belongs in the inbox
  // with the same membership truth as everywhere else. archivedAt rides
  // from the rooms row; a seat whose room row is gone reads as archived
  // (the old INNER JOIN dropped it the same way).
  const seats = identityRoomSeats(store.db, identity.identityId,
    { after: scopedRoom === null ? parsed.roomAfter ?? "" : "", limit: MAX_ROOMS + 1 });
  const roomRows = seats.length ? store.db.prepare(
    `SELECT id, archived_at AS archivedAt FROM rooms WHERE id IN (${seats.map(() => "?").join(",")})`
  ).all(...seats.map(seat => seat.roomId)) : [];
  const archivedByRoom = new Map(roomRows.map(row => [row.id, row.archivedAt]));
  const links = seats.map(seat => ({
    ...seat,
    archivedAt: archivedByRoom.has(seat.roomId) ? archivedByRoom.get(seat.roomId) : 1
  })).filter(link => scopedRoom === null || link.roomId === scopedRoom);
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
  let hasMore = scopedRoom === null && links.length > MAX_ROOMS;
  // Bounded-scan report for this read (W2-F9-CURE): rows examined by the
  // reply and mention-horizon scans across the rooms this page walked,
  // and whether any scan stopped at its row budget before its range end.
  // An exhausted read never looks complete: it carries hasMore=true with
  // a cursor at scanned ground, and scan.exhausted says why.
  // Round 2 adds the per-scan components (replies / mentions) and the
  // examined body bytes: the aggregate scannedRows used to hide which
  // scan spent what, and the mention component counted returned mention
  // rows rather than the events the scan actually stepped over.
  const scan = { scannedRows: 0, scannedBytes: 0, exhausted: false,
    replies: { scannedRows: 0, scannedBytes: 0, exhausted: false },
    mentions: { scannedRows: 0, scannedBytes: 0, exhausted: false },
    dms: { scannedRows: 0, scannedBytes: 0, exhausted: false } };
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
    const after = Math.min(roomWatermark(parsed, link.roomId, authority.sequence, freshWindow), authority.sequence);
    const floor = store.historyFloor(link.roomId, link.memberId, authority.sequence);
    const messageAfter = Math.max(after, floor ? floor.sequence - 1 : 0);
    const pendingAfter = parsed.provided ? after : 0;
    const pendingMessageAfter = Math.max(pendingAfter, floor ? floor.sequence - 1 : 0);
    const landAfter = landWatermark(parsed, link.roomId);
    const horizonScan = mentionHorizon(store, link.roomId, link.memberId, messageAfter, sessionWatermark(after, authority.sequence));
    scan.scannedRows += horizonScan.scannedRows;
    scan.scannedBytes += horizonScan.scannedBytes;
    scan.exhausted = scan.exhausted || horizonScan.exhausted;
    scan.mentions.scannedRows += horizonScan.scannedRows;
    scan.mentions.scannedBytes += horizonScan.scannedBytes;
    scan.mentions.exhausted = scan.mentions.exhausted || horizonScan.exhausted;
    let through = horizonScan.horizon;
    let candidates = [];
    if (authority.sequence > after) {
      const state = store.room(link.roomId).state;
      const replyScan = repliesOf(store, link.roomId, link.memberId, messageAfter, through, state);
      scan.scannedRows += replyScan.scannedRows;
      scan.scannedBytes += replyScan.scannedBytes;
      scan.exhausted = scan.exhausted || replyScan.exhausted;
      scan.replies.scannedRows += replyScan.scannedRows;
      scan.replies.scannedBytes += replyScan.scannedBytes;
      scan.replies.exhausted = scan.replies.exhausted || replyScan.exhausted;
      // Budget exhaustion clamps the window to scanned ground (see
      // repliesOf): every kind is then windowed to examined sequences,
      // `pending` below keeps hasMore true, and the reported cursor
      // cannot advance past the unscanned remainder.
      if (replyScan.exhausted) through = Math.min(through, replyScan.scannedThrough);
      const dmScan = roomDmsOf(store, link.roomId, link.memberId, messageAfter, through, state);
      scan.scannedRows += dmScan.scannedRows;
      scan.scannedBytes += dmScan.scannedBytes;
      scan.exhausted = scan.exhausted || dmScan.exhausted;
      scan.dms.scannedRows += dmScan.scannedRows;
      scan.dms.scannedBytes += dmScan.scannedBytes;
      scan.dms.exhausted = scan.dms.exhausted || dmScan.exhausted;
      if (dmScan.exhausted) through = Math.min(through, dmScan.scannedThrough);
      const kinds = [
        mentionsOf(store, link.roomId, link.memberId, messageAfter, through),
        replyScan.items,
        dmScan.items,
        peerDmsOf(store, link.roomId, identity.identityId, after),
        bondRequestsOf(store, link.roomId, pendingBonds, pendingAfter),
        directAsksOf(store, link.roomId, link.memberId, pendingMessageAfter, state),
        handoffsOf(store, link.roomId, link.memberId, pendingAfter, state)
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
    // F-S6c-3: the reported cursor is the member's visible horizon, not
    // the scanned horizon — the raw sequence counts private events the
    // member cannot see and lets them compute how many hidden events
    // exist. The internal `through` (and the pending check below) stays
    // on the scanned horizon, so a hidden tail event does not pin
    // hasMore on forever: the next poll rescans from the reported
    // cursor, finds nothing new for this member, and completes.
    rooms[link.roomId] = visibleSequenceHorizon(store.db, link.roomId, link.memberId, through,
      authority.ownerId === link.memberId);
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
  const pausedRooms = store.agentHeartbeats?.pausedRoomsOf?.(identity.identityId)?.filter(p =>
    (!allowedRooms || allowedRooms.includes(p.roomId)) && (scopedRoom === null || p.roomId === scopedRoom)) ?? [];
  if (pausedRooms.length) {
    const held = new Set(pausedRooms.map(p => p.roomId));
    for (let i = 0; i < items.length; i++) if (held.has(items[i]?.roomId)) items[i] = { ...items[i], paused: true };
  }
  return stampNeedsMe({ identityId: identity.identityId, items, ...(pausedRooms.length ? { paused: pausedRooms } : {}), ...(openWork.length ? { openWork } : {}), ...(reviewAsks.length ? { reviewAsks } : {}), ...(myWork.length ? { myWork } : {}), ...(myClaims.length ? { myClaims } : {}), ...(actionsNeeded.length ? { actionsNeeded } : {}), cursor, hasMore,
    scan: { scannedRows: scan.scannedRows, scannedBytes: scan.scannedBytes, exhausted: scan.exhausted, replies: scan.replies, mentions: scan.mentions, dms: scan.dms, rowBudgets: { replies: REPLY_SCAN_ROW_BUDGET, mentions: MENTION_SCAN_ROW_BUDGET, dms: DM_SCAN_ROW_BUDGET }, byteBudgets: { replies: REPLY_SCAN_BYTE_BUDGET, mentions: MENTION_SCAN_BYTE_BUDGET, dms: DM_SCAN_BYTE_BUDGET }, ...(scan.exhausted ? { continuation: "pass the returned cursor back unchanged; the scan resumes at the first unscanned sequence" } : {}) } });
}
