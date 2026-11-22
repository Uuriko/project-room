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
// (server/messages-store.mjs) puts every moved message back.

import { ARCHIVE_DEFAULT_KEEP, operatorArchive } from "./operator-archive.mjs";
import { healBackfillQuarantines, messagesBackfillCaughtUp } from "./messages-store.mjs";

export const RELIEF_REASON = "store-growth automatic projection relief";
export const RELIEF_ROOMS_PER_TICK = 3;
export const RELIEF_CATCH_UP_EVENTS = 500;
export const RELIEF_CATCH_UP_CHUNK = 50;

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

// The caller's tick deadline (ms epoch, the ctx.deadline convention the
// other slow jobs already honour). Relief is the expensive leg of the
// store-growth tick: unbounded, it outlived the job budget, the RPC was
// terminated, and the tick's breach failure was never recorded. When the
// deadline passes, relief stops cleanly instead: rooms past the line that
// were not attempted are counted as deferred, and the events still
// awaiting catch-up replay are counted too, so the tick returns, records
// its breach, and the next tick resumes from the per-chunk cursor the
// backfill commits (progress accumulates across ticks).
function deadlineExpired(deadline) {
  return Number.isFinite(deadline) && Date.now() > deadline;
}

function catchUpRemaining(db, roomId) {
  try {
    const row = db.prepare(`SELECT r.sequence - COALESCE(c.applied_seq, 0) AS remaining
      FROM rooms r LEFT JOIN messages_backfill_cursor c ON c.room_id = r.id WHERE r.id = ?`).get(roomId);
    return Number.isInteger(row?.remaining) && row.remaining > 0 ? row.remaining : 0;
  } catch { return 0; }
}

// Production's 4,000-event synchronous catch-up exceeded the DO CPU limit
// even in a separate RPC. Bound total replay and yield between small commits
// so serving requests can run. The final plan/apply remains synchronous and
// rechecks the current head; no plan survives an await.
export async function relieveProjectionsIncrementally(store, options = {}) {
  const { limitBytes, recovery = null, maxRooms = RELIEF_ROOMS_PER_TICK,
    eventCap = RELIEF_CATCH_UP_EVENTS, chunkSize = RELIEF_CATCH_UP_CHUNK,
    deadline = Infinity,
    yieldWork = () => new Promise(resolve => setTimeout(resolve, 0)) } = options;
  if (!Number.isInteger(eventCap) || eventCap < 1 || !Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("Relief catch-up limits must be positive integers");
  }
  let catchUpEvents = 0, catchUpChunks = 0, deferredEvents = 0;
  if (!store?.readOnly && Number.isFinite(limitBytes) && recovery && typeof recovery === "object") {
    // A quarantined event must not keep this room out of catch-up. The
    // heal is the same one the integrity tick runs; a real park (skipped=0)
    // still skips catch-up and archives below the cursor.
    try { healBackfillQuarantines(store); } catch { /* parked() still treats an unreadable row as not parked */ }
    const pastLine = roomsPastLine(store.db, limitBytes, maxRooms);
    for (let index = 0; index < pastLine.length; index++) {
      const roomId = pastLine[index];
      if (parked(store.db, roomId)) continue;
      let stopped = false;
      while (catchUpEvents < eventCap && !messagesBackfillCaughtUp(store.db, roomId)) {
        // Each chunk commits its own cursor, so stopping here loses
        // nothing: the deferred events are replayed by a later tick.
        if (deadlineExpired(deadline)) { stopped = true; break; }
        await yieldWork();
        if (deadlineExpired(deadline)) { stopped = true; break; }
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
      if (stopped) {
        // Count every event this tick leaves unreplayed: the rest of this
        // room's replay plus every later past-line room not yet visited.
        for (let later = index; later < pastLine.length; later++) {
          if (!parked(store.db, pastLine[later])) deferredEvents += catchUpRemaining(store.db, pastLine[later]);
        }
        break;
      }
    }
  }
  const result = relieveProjections(store, { ...options, archive: (target, request) =>
    operatorArchive(target, { ...request,
      // The existing prefix archive checks its exact cursor and retains every
      // message named by a later event, including edits, replies and pins.
      belowCursor: request.belowCursor || !messagesBackfillCaughtUp(target.db, request.roomId)
    }, null, { eventCap: 0 }) });
  return { ...result, catchUpEvents, catchUpChunks, ...(deferredEvents > 0 ? { deferredEvents } : {}) };
}

// Returns { attempted, relieved, freedBytes, refused } with counts only:
// the summary rides the public health surface, so no room ids or text.
// When a deadline is handed in and passes mid-pass, rooms not yet
// attempted are counted as deferred (present only when nonzero, like
// backupMissing) and the pass stops instead of overrunning the tick.
export function relieveProjections(store, { limitBytes, recovery = null, keepNewest = ARCHIVE_DEFAULT_KEEP, maxRooms = RELIEF_ROOMS_PER_TICK, archive = operatorArchive, deadline = Infinity } = {}) {
  const result = { attempted: 0, relieved: 0, freedBytes: 0, refused: 0 };
  if (store?.readOnly || !Number.isFinite(limitBytes)) return result;
  if (!recovery || typeof recovery !== "object") {
    const waiting = roomsPastLine(store.db, limitBytes, maxRooms).length;
    return waiting ? { ...result, backupMissing: 1 } : result;
  }
  const pastLine = roomsPastLine(store.db, limitBytes, maxRooms);
  for (let index = 0; index < pastLine.length; index++) {
    if (deadlineExpired(deadline)) { result.deferred = pastLine.length - index; break; }
    const roomId = pastLine[index];
    result.attempted += 1;
    const request = { roomId, keepNewest, reason: RELIEF_REASON, belowCursor: parked(store.db, roomId) };
    try {
      const plan = archive(store, { ...request, dryRun: true });
      if (!plan?.ok || !(plan.expect?.archived > 0)) { result.refused += 1; continue; }
      const done = archive(store, { ...request, dryRun: false, expect: plan.expect });
      if (!done?.ok) { result.refused += 1; continue; }
      result.relieved += 1;
      result.freedBytes += Math.max(0, Number(done.projectionBytes?.before) - Number(done.projectionBytes?.after)) || 0;
    } catch (error) {
      result.refused += 1;
      console.warn(`[store-growth] relief refused (${errorCode(error)})`);
    }
  }
  return result;
}
