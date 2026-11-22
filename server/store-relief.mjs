// Automatic projection relief for the store-growth job.
//
// The store-growth job named a room projection past the 3.5 MB escalation
// line but nothing acted on it: the only way to shed old history was the
// operator archive door (server/operator-archive.mjs), called by hand. On
// prod the largest room grew past the line and toward the 4 MiB app cap,
// where every write to that room fails with 409 pilot_limit.
//
// This is the same door, driven by the job: for each room past the line
// (largest first, a few per tick) it runs a dry run and then a real run
// against that dry run's exact counts, so every step keeps the door's
// guarantees: certification, plan_changed on drift, the existing reversible
// archive format, and an operator_actions audit row for each call. A room
// parked by a messages backfill block archives below its cursor only, which
// never re-runs the parked backfill and keeps every message a later event
// names. A refusal is reported, never retried in the same tick, and never
// fails the tick on its own: the breach that remains is what pages.
//
// Recovery gate (QA delta 17987, docs/OPERATOR.md "Take a backup first"):
// relief runs only when the caller hands it a verified recovery point (the
// store-growth job passes the newest verified daily backup, at most a day
// old). Without one nothing is archived and the summary says so
// (backupMissing: 1); the breach still fails the tick. The archive itself is
// reversible from the event log: restoreArchivedMessages
// (server/messages-store.mjs) puts every moved message back. A Node process
// has no R2/KV backup, so its scheduler hands relief a verified local SQLite
// copy instead (server/node-recovery-point.mjs); before that, relief on Node
// could never run and a full room stayed at 409 pilot_limit.
//
// Default automatic archive: the line is RELIEF_HIGH_WATER_RATIO (80%) of
// the store's projection byte limit, or the store-growth escalation line if
// that is lower, so relief starts before writes fail. A refused room backs
// off (1 h doubling to a day) when the caller keeps a backoff map, so a room
// that cannot certify is tried once per window, never in a loop.

import { ARCHIVE_DEFAULT_KEEP, operatorArchive } from "./operator-archive.mjs";
import { healBackfillQuarantines, messagesBackfillCaughtUp } from "./messages-store.mjs";

export const RELIEF_REASON = "store-growth automatic projection relief";
export const RELIEF_ROOMS_PER_TICK = 3;
export const RELIEF_CATCH_UP_EVENTS = 500;
export const RELIEF_CATCH_UP_CHUNK = 50;
// Automatic relief starts before the write cap: a room is relieved once its
// projection passes this share of the store's projection byte limit (or the
// store-growth escalation line, whichever is lower).
export const RELIEF_HIGH_WATER_RATIO = 0.8;
// A refused room waits before the next attempt: 1 h, 2 h, 4 h ... capped at
// a day. One attempt per room per window; success clears the wait.
export const RELIEF_BACKOFF_BASE_MS = 60 * 60 * 1000;
export const RELIEF_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export function reliefLineBytes(store, escalationBytes = Infinity) {
  const cap = Number(store?.projectionByteLimit);
  const highWater = Number.isFinite(cap) && cap > 0 ? Math.floor(cap * RELIEF_HIGH_WATER_RATIO) : Infinity;
  const line = Math.min(highWater, Number(escalationBytes));
  return Number.isFinite(line) && line > 0 ? line : null;
}

function backedOff(backoff, roomId, at) {
  const entry = backoff?.get(roomId);
  return Boolean(entry && Number(entry.nextAt) > at);
}

function noteRefusal(backoff, roomId, at) {
  if (!backoff) return;
  const failures = (backoff.get(roomId)?.failures ?? 0) + 1;
  const wait = Math.min(RELIEF_BACKOFF_MAX_MS, RELIEF_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16));
  backoff.set(roomId, { failures, nextAt: at + wait });
}

function dueRooms(db, limitBytes, max, backoff, at) {
  const candidates = roomsPastLine(db, limitBytes, max + (backoff?.size ?? 0));
  const due = candidates.filter(roomId => !backedOff(backoff, roomId, at));
  return { due: due.slice(0, max), deferred: candidates.length - due.length };
}

function roomsPastLine(db, limitBytes, max) {
  return db.prepare(`SELECT id FROM rooms WHERE length(CAST(projection AS BLOB)) > ?
    ORDER BY length(CAST(projection AS BLOB)) DESC LIMIT ?`).all(limitBytes, max).map(row => row.id);
}

function parked(db, roomId) {
  try { return Boolean(db.prepare("SELECT 1 FROM messages_backfill_blocks WHERE room_id=? AND skipped=0").get(roomId)); }
  catch { return false; }
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "relief_failed";
}

// Production's 4,000-event synchronous catch-up exceeded the DO CPU limit
// even in a separate RPC. Bound total replay and yield between small commits
// so serving requests can run. The final plan/apply remains synchronous and
// rechecks the current head; no plan survives an await.
export async function relieveProjectionsIncrementally(store, options = {}) {
  const { limitBytes, recovery = null, maxRooms = RELIEF_ROOMS_PER_TICK,
    eventCap = RELIEF_CATCH_UP_EVENTS, chunkSize = RELIEF_CATCH_UP_CHUNK, backoff = null, now = () => Date.now(),
    yieldWork = () => new Promise(resolve => setTimeout(resolve, 0)) } = options;
  if (!Number.isInteger(eventCap) || eventCap < 1 || !Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("Relief catch-up limits must be positive integers");
  }
  let catchUpEvents = 0, catchUpChunks = 0;
  if (!store?.readOnly && Number.isFinite(limitBytes) && recovery && typeof recovery === "object") {
    // A quarantined event must not keep this room out of catch-up. The
    // heal is the same one the integrity tick runs; a real park (skipped=0)
    // still skips catch-up and archives below the cursor.
    try { healBackfillQuarantines(store); } catch { /* parked() still treats an unreadable row as not parked */ }
    for (const roomId of dueRooms(store.db, limitBytes, maxRooms, backoff, now()).due) {
      if (parked(store.db, roomId)) continue;
      while (catchUpEvents < eventCap && !messagesBackfillCaughtUp(store.db, roomId)) {
        await yieldWork();
        let result;
        try { result = store.backfillMessages({ limit: Math.min(chunkSize, eventCap - catchUpEvents) }); }
        catch {
          // The guarded archive below still records a refusal. A corrupt or
          // blocked room must not prevent the other oversized rooms' checks.
          break;
        }
        catchUpChunks += 1;
        const events = Number.isInteger(result.events) && result.events > 0 ? result.events : 0;
        catchUpEvents += events;
        if (!events || result.done || result.budgetExceeded || parked(store.db, roomId)) break;
      }
    }
  }
  const result = relieveProjections(store, { ...options, archive: (target, request) =>
    operatorArchive(target, { ...request,
      // The existing prefix archive checks its exact cursor and retains every
      // message named by a later event, including edits, replies and pins.
      belowCursor: request.belowCursor || !messagesBackfillCaughtUp(target.db, request.roomId)
    }, null, { eventCap: 0 }) });
  return { ...result, catchUpEvents, catchUpChunks };
}

// Returns { attempted, relieved, freedBytes, refused } with counts only:
// the summary rides the public health surface, so no room ids or text.
// `backoff` (a Map the caller keeps across ticks) skips a room refused in an
// earlier window until its wait ends; `deferred` counts the skipped rooms.
export function relieveProjections(store, { limitBytes, recovery = null, keepNewest = ARCHIVE_DEFAULT_KEEP, maxRooms = RELIEF_ROOMS_PER_TICK, archive = operatorArchive, backoff = null, now = () => Date.now() } = {}) {
  const result = { attempted: 0, relieved: 0, freedBytes: 0, refused: 0 };
  if (store?.readOnly || !Number.isFinite(limitBytes)) return result;
  const at = now();
  const { due, deferred } = dueRooms(store.db, limitBytes, maxRooms, backoff, at);
  if (deferred) result.deferred = deferred;
  if (!recovery || typeof recovery !== "object") {
    return due.length ? { ...result, backupMissing: 1 } : result;
  }
  for (const roomId of due) {
    result.attempted += 1;
    const request = { roomId, keepNewest, reason: RELIEF_REASON, belowCursor: parked(store.db, roomId) };
    try {
      const plan = archive(store, { ...request, dryRun: true });
      if (!plan?.ok || !(plan.expect?.archived > 0)) { result.refused += 1; noteRefusal(backoff, roomId, at); continue; }
      const done = archive(store, { ...request, dryRun: false, expect: plan.expect });
      if (!done?.ok) { result.refused += 1; noteRefusal(backoff, roomId, at); continue; }
      backoff?.delete(roomId);
      result.relieved += 1;
      result.freedBytes += Math.max(0, Number(done.projectionBytes?.before) - Number(done.projectionBytes?.after)) || 0;
    } catch (error) {
      result.refused += 1;
      noteRefusal(backoff, roomId, at);
      console.warn(`[store-growth] relief refused (${errorCode(error)})`);
    }
  }
  return result;
}
