// P0-6: give archiveRoomMessages its two missing callers — an owner-only
// operator route (server/operator-archive.mjs) and a threshold job in
// server/jobs.mjs. This module is the shared core both call: when a room's
// stored projection crosses 70% of the projection cap
// (PILOT_LIMITS.projectionBytes, 4 MiB), archival is due for that room.
//
// Dry-run is the default posture everywhere. A plan reports what WOULD move
// — message count, bytes, oldest/newest timestamps of the moving set, and
// the resulting projection size — and moves nothing. Moving messages takes
// an explicit dryRun:false, which only the operator route's explicit
// "live":true body flag or the job's ROOM_MESSAGES_ARCHIVE_LIVE=1 env opt-in
// can supply; neither is set by default anywhere.
//
// Per-room-design note (PER-ROOM-DESIGN §7, which counts nothing in P0 as
// throwaway): the trigger math, the dry-run report shape, and the
// archiveRoomMessages call survive a one-DO-per-room split verbatim —
// inside a room DO the same question is asked of the single room. Only
// roomsOverArchiveTrigger's cross-room enumeration is monolith-shaped; on
// migration it converts to that per-room check (the §7 pattern for P0-3:
// converts rather than expires). Flagged to the coordinator in the P0-6
// report as the one spot where "nothing is throwaway" needs this nuance.

import { PILOT_LIMITS } from "./store.mjs";
import { archiveRoomMessages, roomProjectionBytes } from "./messages-store.mjs";

export const ARCHIVE_TRIGGER_FRACTION = 0.7;
// After a live run the room should sit at or below this share of the cap,
// so the job does not re-trigger on the next tick for the same room.
export const ARCHIVE_TARGET_FRACTION = 0.5;
// Floor for any live run, however the arithmetic comes out: the newest
// messages always stay in the projection.
export const ARCHIVE_MIN_KEEP_NEWEST = 100;
// A live run never moves more than this many messages in one pass; the
// next tick continues the remainder (cooperative progress, like the other
// budgeted jobs).
export const ARCHIVE_MAX_PER_RUN = 5000;
// Env opt-in for the job's live mode. Unset, blank, or anything but "1"
// keeps the job reporting dry-run plans only.
export const ARCHIVE_LIVE_ENV = "ROOM_MESSAGES_ARCHIVE_LIVE";

// The first projection size, in bytes, that is over the trigger:
// strictly more than 70% of the 4 MiB cap (0.70 × 4,194,304 = 2,936,012.8,
// so 2,936,013 bytes is the first triggering size).
export function archiveTriggerBytes(capBytes = PILOT_LIMITS.projectionBytes) {
  return Math.floor(capBytes * ARCHIVE_TRIGGER_FRACTION) + 1;
}

export function archiveTargetBytes(capBytes = PILOT_LIMITS.projectionBytes) {
  return Math.floor(capBytes * ARCHIVE_TARGET_FRACTION);
}

// Ids and stored sizes of every room over the trigger, largest first.
// Returns [] when the rooms table cannot be read (a store without the
// schema yet has no room that can be archived).
export function roomsOverArchiveTrigger(store, capBytes = PILOT_LIMITS.projectionBytes) {
  if (!store?.db?.prepare) return [];
  let rows;
  try {
    rows = store.db.prepare("SELECT id, length(CAST(projection AS BLOB)) AS bytes FROM rooms").all();
  } catch { return []; }
  const trigger = archiveTriggerBytes(capBytes);
  return rows
    .map(row => ({ roomId: row.id, projectionBytes: Number(row.bytes) || 0 }))
    .filter(row => row.projectionBytes >= trigger)
    .sort((a, b) => b.projectionBytes - a.projectionBytes);
}

// Smallest keepNewest whose dry-run plan brings the room to the target
// size. archiveRoomMessages is pure in dry-run, so doubling then bisecting
// over keepNewest costs only dry-run passes and changes nothing. Falls
// back to the floor when even keeping the minimum cannot reach the target
// (retained messages alone exceed it) — the plan then reports the honest
// remainder. Returns null when no plan can be produced for the room.
export function planArchiveToTarget(store, roomId, { capBytes = PILOT_LIMITS.projectionBytes, targetBytes = archiveTargetBytes(capBytes) } = {}) {
  const probe = keep => {
    try { return store.archiveMessages(roomId, { keepNewest: keep, dryRun: true }); }
    catch { return null; }
  };
  const first = probe(ARCHIVE_MIN_KEEP_NEWEST);
  if (!first?.ok) return null;
  if (first.archived === 0 || first.resultingProjectionBytes <= targetBytes) {
    return { keepNewest: ARCHIVE_MIN_KEEP_NEWEST, plan: first };
  }
  // Invariant: lo's plan is over target, hi's plan is at or under it (or hi
  // is the whole projection, which moves nothing and cannot be the answer —
  // checked by the archived===0 guard after the loop).
  let lo = ARCHIVE_MIN_KEEP_NEWEST;
  let hi = Math.max(lo * 2, lo + 1);
  let hiPlan = probe(hi);
  while (hiPlan?.ok && hiPlan.archived > 0 && hiPlan.resultingProjectionBytes > targetBytes) {
    lo = hi;
    hi *= 2;
    hiPlan = probe(hi);
  }
  if (!hiPlan?.ok) return null;
  if (hiPlan.archived === 0) return { keepNewest: lo, plan: probe(lo) };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midPlan = probe(mid);
    if (!midPlan?.ok) return null;
    if (midPlan.resultingProjectionBytes <= targetBytes) { hi = mid; hiPlan = midPlan; }
    else lo = mid;
  }
  return { keepNewest: hi, plan: hiPlan };
}

// One room's dry-run report: the archive plan against the trigger math.
// live:false and nothing moved — the plan comes from archiveRoomMessages
// in its default dry-run mode.
export function archiveDryRunReport(store, roomId, { capBytes = PILOT_LIMITS.projectionBytes } = {}) {
  const projectionBytes = roomProjectionBytes(store, roomId);
  if (projectionBytes == null) return { ok: false, reason: "room_not_found", roomId };
  const triggerBytes = archiveTriggerBytes(capBytes);
  const base = {
    ok: true, roomId, dryRun: true, live: false,
    projectionBytes, capBytes, triggerBytes,
    overTrigger: projectionBytes >= triggerBytes
  };
  const planned = planArchiveToTarget(store, roomId, { capBytes });
  if (!planned) {
    // The store refused the plan (uncertified messages table, missing
    // rows, a failed spot check): surface archiveRoomMessages' own verdict
    // instead of inventing numbers.
    let verdict = null;
    try { verdict = store.archiveMessages(roomId, { keepNewest: ARCHIVE_MIN_KEEP_NEWEST, dryRun: true }); }
    catch { verdict = null; }
    return { ...base, wouldArchive: 0, plan: verdict ?? { ok: false, reason: "archive_unavailable" } };
  }
  return { ...base, keepNewest: planned.keepNewest, wouldArchive: planned.plan.archived, plan: planned.plan };
}

// The job's live mode for one room: same plan as the dry-run report, then
// one bounded live pass. Never called unless the caller opted in.
export function runLiveArchive(store, roomId, { capBytes = PILOT_LIMITS.projectionBytes } = {}) {
  const planned = planArchiveToTarget(store, roomId, { capBytes });
  if (!planned) return { ok: false, reason: "archive_unavailable", roomId };
  if (planned.plan.archived === 0) return { ...planned.plan, roomId };
  const keepNewest = Math.max(planned.keepNewest, planned.plan.archived > ARCHIVE_MAX_PER_RUN
    ? totalMessages(store, roomId) - ARCHIVE_MAX_PER_RUN
    : planned.keepNewest);
  const result = archiveRoomMessages(store, roomId, { keepNewest, dryRun: false });
  return { ...result, roomId };
}

function totalMessages(store, roomId) {
  try { return store.room(roomId).state.messages?.length ?? 0; }
  catch { return 0; }
}

export function archiveLiveOptedIn(env = globalThis.process?.env ?? {}) {
  return env?.[ARCHIVE_LIVE_ENV] === "1";
}

// One job tick over every room past the trigger. Default posture is
// dry-run: the tick returns the per-room reports and moves nothing. With
// the env opt-in it runs one bounded live pass per room instead.
export function runMessagesArchiveTick(store, { env = globalThis.process?.env ?? {}, capBytes = PILOT_LIMITS.projectionBytes } = {}) {
  const live = archiveLiveOptedIn(env);
  const rooms = roomsOverArchiveTrigger(store, capBytes);
  const reports = [];
  let wouldArchive = 0;
  let archived = 0;
  for (const room of rooms) {
    if (live) {
      const result = runLiveArchive(store, room.roomId, { capBytes });
      reports.push(result);
      if (result.ok) archived += result.archived ?? 0;
    } else {
      const report = archiveDryRunReport(store, room.roomId, { capBytes });
      reports.push(report);
      if (report.ok) wouldArchive += report.wouldArchive ?? 0;
    }
  }
  return { rooms: rooms.length, dryRun: !live, live, wouldArchive, archived, reports };
}
