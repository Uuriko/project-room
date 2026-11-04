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
  chargeCurrentReadBudget, isCurrentRoom, readCurrentRecord, readCurrentWorkItem, withCurrentReadContext,
} from "./current-room-repository.mjs";

const WORK_KEY_PAGE = 64;

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
// Board registry exactly as before). Enumeration is bounded: work
// keys page through the current_work_summary_keys proof index (as
// readCurrentOverviewWindow does), thin summaries pre-filter
// terminality, and only terminal candidates pay a full
// readCurrentWorkItem, whose result is re-checked before mapping.
export function currentReceiptClaims(store, roomId) {
  const db = store?.db;
  if (!db || !isCurrentRoom(db, roomId)) return null;
  return withCurrentReadContext(db, roomId, budget => {
    const ids = [];
    let after = "";
    for (;;) {
      const rows = db.prepare(
        "SELECT record_key FROM current_room_record_proofs INDEXED BY current_work_summary_keys"
        + " WHERE room_id=? AND domain='workSummary' AND present=1 AND record_key>?"
        + " ORDER BY record_key LIMIT ?",
      ).all(roomId, after, WORK_KEY_PAGE);
      chargeCurrentReadBudget(budget, rows.reduce((n, row) => n + Buffer.byteLength(row.record_key) + 32, 0), rows.length);
      if (rows.length === 0) break;
      ids.push(...rows.map(row => row.record_key));
      after = rows[rows.length - 1].record_key;
      if (rows.length < WORK_KEY_PAGE) break;
    }
    const claims = [];
    for (const id of ids) {
      const thin = readCurrentRecord(db, roomId, "workSummary", id, budget)?.work;
      if (!isTerminalCompletion(thin)) continue;
      const item = readCurrentWorkItem(db, roomId, id, budget);
      if (!isTerminalCompletion(item)) continue;
      claims.push(claimShapeOf(db, roomId, item));
    }
    return claims;
  }, { maxRecords: 1024 });
}
