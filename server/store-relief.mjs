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

import { ARCHIVE_DEFAULT_KEEP, operatorArchive } from "./operator-archive.mjs";

export const RELIEF_REASON = "store-growth automatic projection relief";
export const RELIEF_ROOMS_PER_TICK = 3;

function roomsPastLine(db, limitBytes, max) {
  return db.prepare(`SELECT id FROM rooms WHERE length(CAST(projection AS BLOB)) > ?
    ORDER BY length(CAST(projection AS BLOB)) DESC LIMIT ?`).all(limitBytes, max).map(row => row.id);
}

function parked(db, roomId) {
  try { return Boolean(db.prepare("SELECT 1 FROM messages_backfill_blocks WHERE room_id=?").get(roomId)); }
  catch { return false; }
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "relief_failed";
}

// Returns { attempted, relieved, freedBytes, refused } with counts only:
// the summary rides the public health surface, so no room ids or text.
export function relieveProjections(store, { limitBytes, keepNewest = ARCHIVE_DEFAULT_KEEP, maxRooms = RELIEF_ROOMS_PER_TICK, archive = operatorArchive } = {}) {
  const result = { attempted: 0, relieved: 0, freedBytes: 0, refused: 0 };
  if (store?.readOnly || !Number.isFinite(limitBytes)) return result;
  for (const roomId of roomsPastLine(store.db, limitBytes, maxRooms)) {
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
