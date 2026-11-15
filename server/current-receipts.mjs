// Native receipts projection (N20-01): the receipts surface in
// server/work-claim-routes.mjs reads the legacy Board store
// (work_claims, state "done"), but current-format rooms never write
// Board rows — the work-item -> Board sync is deliberately gated off
// for them (server/store.mjs, "Native rooms use exact canonical work
// proofs, not retired Board mirrors") and legacy Board writes are
// refused. Their receipts therefore always read empty.
//
// This projector is the read-side replacement: it enumerates the
// room's canonical work items through the existing bounded current
// readers and maps each terminal completion to the Board-claim shape
// the receipts handlers already project (state "done" plus a
// state:done history stamp), so the legacy handlers — filtering,
// ranking, receiptOf / receiptWithPublicLink — run unchanged on the
// result. Nothing is written: no Board rows, no sync re-enabled.
//
// Terminal means terminalWork (src/workflow.js): the item is
// completed, its receipt carries eventId + evidenceVersion, and
// verification is satisfied (a confirmed independent pass where
// required) or the owner approved the exact receipt where an owner
// decision is required. A merely-completed (delivered, unverified)
// item is NOT a receipt.
import { WORK_STATES } from "../src/events.js";
import { terminalWork } from "../src/workflow.js";
import { boardClaimId } from "./work-item-board.mjs";
import {
  chargeCurrentReadBudget, isCurrentRoom, readCurrentRecord, readCurrentWorkItem,
  remainingCurrentReadBytes, withCurrentReadContext,
} from "./current-room-repository.mjs";

// One window of work keys per read context (B7 cure). A single context
// charges ~43.6 KiB of schema/head admission before the first record,
// then ~2.4 KiB per thin summary (flat 1024 + payload + transition
// receipt) and ~4.2 KiB more per full terminal item, against the
// platform's 256 KiB MAX_INPUT — so one context for a whole room
// exhausts at ~90 items no matter how few receipts exist. Sixteen keys
// per window keeps even an all-terminal window (~150 KiB measured
// shape) inside the budget, and the per-item reserve check below
// defers an item to the next window before the budget can throw.
const WORK_KEY_PAGE = 16;

// The completion (or verification) event's recorded time. The events
// table is the room's own log; a missing row falls back to the item's
// own timestamps rather than inventing a time.
const eventAtMs = (db, roomId, eventId, fallbackIso) => {
  if (eventId) {
    const row = db.prepare("SELECT json_extract(body, '$.at') AS at FROM events WHERE room_id=? AND id=?").get(roomId, eventId);
    const ms = row ? Date.parse(row.at) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  const fallback = Date.parse(fallbackIso ?? "");
  return Number.isFinite(fallback) ? fallback : 0;
};

const isTerminalCompletion = item => Boolean(item)
  && item.state === WORK_STATES.COMPLETED
  && Boolean(item.receipt?.eventId && item.receipt?.evidenceVersion)
  && terminalWork(item);

// Map one canonical work item to the claim shape receiptOf consumes:
// the done stamp's note is the completion summary and its `at` is the
// completion time; verification is carried in the receipt's existing
// {state, by, at, executedChecks} shape (native verifications record
// no executed-check list); deliveryDigest stays null — native
// completions have no Board delivery bundle.
const claimShapeOf = (db, roomId, item) => {
  const completedMs = eventAtMs(db, roomId, item.receipt.eventId, item.updatedAt ?? item.createdAt);
  const verification = item.verification ? Object.freeze({
    state: item.verification.result ?? null,
    by: item.verification.verifierId ?? item.verification.actorId ?? null,
    at: item.verification.eventId
      ? eventAtMs(db, roomId, item.verification.eventId, item.updatedAt ?? item.createdAt)
      : null,
    executedChecks: Object.freeze([]),
  }) : null;
  return Object.freeze({
    id: boardClaimId(item.id),
    title: item.title ?? item.id,
    tags: Object.freeze([]),
    blobs: Object.freeze([]),
    owner: item.receipt.producerId ?? item.receipt.reportedById ?? null,
    state: "done",
    history: Object.freeze([Object.freeze({
      action: "state:done",
      at: new Date(completedMs).toISOString(),
      note: item.receipt.summary ?? "",
    })]),
    verification,
    delivery: null,
  });
};

// The room state receiptWithPublicLink needs for its opt-in check, in
// the { room } shape publicReceipts reads. store.room() refuses
// current rooms outright (409 current_room_context_required — full
// hydration is not an addressed read), so the twin check's state has
// to come from the bounded metadata record instead. Returns null for
// non-current rooms, whose callers keep using store.room().
export function currentRoomReceiptState(store, roomId) {
  const db = store?.db;
  if (!db || !isCurrentRoom(db, roomId)) return null;
  return withCurrentReadContext(db, roomId, budget => ({
    room: readCurrentRecord(db, roomId, "metadata", "room", budget) ?? null,
  }));
}

// The room's native receipts as claim-shaped items, or null when the
// room is not a current-format room (the caller then uses the legacy
// Board registry exactly as before). Enumeration is windowed (B7):
// work keys page through the current_work_summary_keys proof index
// (as readCurrentOverviewWindow does) in WORK_KEY_PAGE windows, each
// window inside its OWN withCurrentReadContext, so the 256 KiB read
// budget is per-window, never per-room. Thin summaries pre-filter
// terminality, and only terminal candidates pay a full
// readCurrentWorkItem, whose result is re-checked before mapping.
// Before examining an item past a window's first, its scalar payload
// sizes are compared with the window's remaining budget; an item
// that might not fit is deferred whole to the next window (where it
// is that window's first item and is always examined), so the budget
// is never thrown mid-room and no item is skipped.
function enumerateTerminal(store, roomId, project) {
  const db = store?.db;
  if (!db || !isCurrentRoom(db, roomId)) return null;
  const claims = [];
  let after = "";
  for (;;) {
    const window = withCurrentReadContext(db, roomId, budget => {
      const rows = db.prepare(
        "SELECT record_key FROM current_room_record_proofs INDEXED BY current_work_summary_keys"
        + " WHERE room_id=? AND domain='workSummary' AND present=1 AND record_key>?"
        + " ORDER BY record_key LIMIT ?",
      ).all(roomId, after, WORK_KEY_PAGE);
      chargeCurrentReadBudget(budget, rows.reduce((n, row) => n + Buffer.byteLength(row.record_key) + 32, 0), rows.length);
      const found = [];
      let examined = 0;
      let examinedAfter = after;
      for (const row of rows) {
        const id = row.record_key;
        if (examined > 0) {
          const thinScalar = db.prepare("SELECT payload_bytes FROM current_room_records WHERE room_id=? AND domain='workSummary' AND record_key=?").get(roomId, id);
          const refScalar = db.prepare("SELECT payload_bytes FROM current_room_records WHERE room_id=? AND domain='workItems' AND record_key=?").get(roomId, id);
          const bodyScalar = db.prepare("SELECT length(CAST(body AS BLOB)) AS bytes FROM work_entities WHERE room_id=? AND work_id=?").get(roomId, id);
          const estimate = (thinScalar?.payload_bytes ?? 0) + (refScalar?.payload_bytes ?? 0)
            + (bodyScalar?.bytes ?? 0) + 16384;
          if (remainingCurrentReadBytes(budget) < estimate) break;
        }
        const thin = readCurrentRecord(db, roomId, "workSummary", id, budget)?.work;
        examined += 1;
        examinedAfter = id;
        if (!isTerminalCompletion(thin)) continue;
        const item = readCurrentWorkItem(db, roomId, id, budget);
        if (!isTerminalCompletion(item)) continue;
        found.push(project(db, roomId, item));
      }
      return { found, fetched: rows.length, examined, examinedAfter };
    }, { maxRecords: 1024 });
    claims.push(...window.found);
    if (window.fetched === 0 || window.examined === 0) break;
    after = window.examinedAfter;
    if (window.examined === window.fetched && window.fetched < WORK_KEY_PAGE) break;
  }
  return claims;
}

export function currentReceiptClaims(store, roomId) {
  return enumerateTerminal(store, roomId, claimShapeOf);
}

// The room's terminal work items themselves (not the claim projection),
// or null when the room is not a current-format room. The public
// receipts read model (L3-D1) projects these at read time for rooms
// that recorded the public-receipts opt-in: current rooms never write
// public_receipts rows (syncRoomPublication returns for them and the
// native publication hook caches room metadata only), so the stored-row
// surfaces can only serve a current room's receipts from this source.
export function currentTerminalWorkItems(store, roomId) {
  return enumerateTerminal(store, roomId, (db, id, item) => item);
}

// One member record of a current room by addressed read, or null when
// the room is not current or the member does not exist. Public receipt
// projection credits members by id; this keeps the read addressed
// (one record) instead of hydrating the room.
export function currentRoomMemberRecord(store, roomId, memberId) {
  const db = store?.db;
  if (!db || typeof memberId !== "string" || !memberId || !isCurrentRoom(db, roomId)) return null;
  try {
    return withCurrentReadContext(db, roomId, budget =>
      readCurrentRecord(db, roomId, "members", memberId, budget) ?? null);
  } catch { return null; }
}

// boardClaimId's "_e" encoding is reversible (see work-item-board.mjs);
// pass-through board-safe ids are the work item id itself. The "_h"
// hash fallback is not reversible; its caller treats it as underivable.
const workItemIdForClaimId = claimId => {
  if (!claimId.startsWith("_e")) return claimId;
  const encoded = claimId.slice(2);
  let decoded = "";
  for (let i = 0; i < encoded.length;) {
    if (encoded[i] !== "_") { decoded += encoded[i]; i += 1; continue; }
    if (encoded.startsWith("__", i)) { decoded += "_"; i += 2; continue; }
    if (encoded.startsWith("_p", i)) { decoded += "."; i += 2; continue; }
    if (encoded.startsWith("_c", i)) { decoded += ":"; i += 2; continue; }
    if (encoded.startsWith("_x", i)) {
      const end = encoded.indexOf("_", i + 2);
      if (end < 0) return null;
      const codePoint = Number.parseInt(encoded.slice(i + 2, end), 16);
      if (!Number.isFinite(codePoint)) return null;
      decoded += String.fromCodePoint(codePoint);
      i = end + 1;
      continue;
    }
    return null;
  }
  return decoded;
};

// One named native receipt as a claim-shaped item, by addressed read:
// the single-receipt route names one work item, so it must not
// enumerate the room (B7: at ~90+ items the enumeration's 409 made
// even a known receipt unreachable). Returns null for non-current
// rooms (caller uses the legacy registry), the claim for a terminal
// completion, or undefined when the named item is not a receipt.
// Only ids whose work item cannot be derived from the claim id (the
// irreversible "_h" boardClaimId fallback) fall back to the windowed
// enumeration above, which is itself budget-bounded per window.
export function currentReceiptClaim(store, roomId, workClaimId) {
  const db = store?.db;
  if (!db || !isCurrentRoom(db, roomId)) return null;
  const claimId = typeof workClaimId === "string" && workClaimId.startsWith("rc_")
    ? workClaimId.slice(3) : workClaimId;
  if (typeof claimId !== "string" || !claimId) return undefined;
  const candidate = claimId.startsWith("_h") ? null : workItemIdForClaimId(claimId);
  if (candidate && boardClaimId(candidate) === claimId) {
    const addressed = withCurrentReadContext(db, roomId, budget => {
      const thin = readCurrentRecord(db, roomId, "workSummary", candidate, budget)?.work;
      if (!isTerminalCompletion(thin)) return undefined;
      const item = readCurrentWorkItem(db, roomId, candidate, budget);
      if (!isTerminalCompletion(item)) return undefined;
      const mapped = claimShapeOf(db, roomId, item);
      return mapped.id === claimId ? mapped : undefined;
    }, { maxRecords: 1024 });
    return addressed;
  }
  return currentReceiptClaims(store, roomId)?.find(claim => claim.id === claimId);
}
