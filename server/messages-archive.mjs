// SPILL-1: give archiveRoomMessages its missing automatic caller — the
// messages-archive job in server/jobs.mjs. The operator door
// (server/operator-archive.mjs) is the manual path; this module is the
// policy core the job ticks on: which rooms are due, and one supervised
// pass at a time.
//
// Sizing basis: PILOT_LIMITS.projectionBytes (4 MiB) is the binding cap —
// it is the limit the store itself enforces on every write
// (server/store.mjs). An earlier build of this module sized against a
// claimed 2 MB Durable Object row limit; that number is false (production
// stores >3.1 MB in a single value today; the platform per-value ceiling
// is 8,388,642 B), so every constant here derives from the app cap and
// every report names that basis (capBasis).
//
// Policy (programme B-6; SPILL-1 charter): a room is due when its stored
// projection reaches a quarter of the cap — 1 MiB at the current cap. A
// live tick archives at most ONE room, the largest due room, keeping the
// newest ARCHIVE_KEEP_NEWEST messages, and only after the room's messages
// table is certified at its head in the same bounded way the operator
// door certifies (certifyRoomMessagesAtHead). A room whose backfill is
// blocked is skipped and recorded, never forced: the certification gate
// is the machinery that keeps a backfill-blocked room out of this lane's
// live runs, and the job never uses the door's belowCursor mode.
//
// Dry-run is the default posture. Without ROOM_MESSAGES_ARCHIVE_LIVE=1
// in the environment the tick plans and reports, and moves nothing; a
// dry run still catches the room's messages table up and certifies it
// (the same catch-up the operator door's dry run performs), which changes
// no projection bytes.
//
// Per-room-design note (PER-ROOM-DESIGN §7, which counts nothing in P0 as
// throwaway): the trigger math, the report shape, and the
// archiveRoomMessages call survive a one-DO-per-room split verbatim —
// inside a room DO the same question is asked of the single room. Only
// roomsOverArchiveTrigger's cross-room enumeration is monolith-shaped;
// on migration it converts to that per-room check (the §7 pattern:
// converts rather than expires).

import { PILOT_LIMITS } from "./store.mjs";
import { certifyRoomMessagesAtHead, roomProjectionBytes } from "./messages-store.mjs";

// The archive sizing contract: the application's own projection cap.
// See the header — NOT a Durable Object row limit.
export const ARCHIVE_CAP_BYTES = PILOT_LIMITS.projectionBytes;
export const ARCHIVE_CAP_BASIS = "pilot-limits-projection-bytes";
// A room is due at this share of the cap: 0.25 × 4 MiB = 1,048,576 bytes
// at the current cap (the programme's B-6 1 MB trigger).
export const ARCHIVE_TRIGGER_FRACTION = 0.25;
// The newest messages always stay in the projection — the operator
// door's standing default (ARCHIVE_DEFAULT_KEEP), one value for both
// callers.
export const ARCHIVE_KEEP_NEWEST = 2000;
// Certification attempts per live tick: a blocked room is skipped, but
// the tick does not sweep the whole store looking for work.
export const ARCHIVE_MAX_ATTEMPTS = 3;
// Env opt-in for the job's live mode. Unset, blank, or anything but "1"
// keeps the job reporting dry-run plans only.
export const ARCHIVE_LIVE_ENV = "ROOM_MESSAGES_ARCHIVE_LIVE";

// The first projection size, in bytes, that is over the trigger.
export function archiveTriggerBytes(capBytes = ARCHIVE_CAP_BYTES) {
  return Math.floor(capBytes * ARCHIVE_TRIGGER_FRACTION);
}

// Ids and stored sizes of every room at or over the trigger, largest
// first. Returns [] when the rooms table cannot be read (a store without
// the schema yet has no room that can be archived).
export function roomsOverArchiveTrigger(store, capBytes = ARCHIVE_CAP_BYTES) {
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

// Certify one room at its head, then plan the archive at the standing
// keepNewest. Returns { ok: true, projectionBytes, plan } or
// { ok: false, reason, detail?, projectionBytes } — never throws for
// "not ready" conditions.
function planRoom(store, roomId, { clock = () => Date.now() } = {}) {
  const projectionBytes = roomProjectionBytes(store, roomId);
  if (projectionBytes == null) return { ok: false, reason: "room_not_found", projectionBytes: null };
  const certified = certifyRoomMessagesAtHead(store, roomId, { deadline: clock() + 15_000 });
  if (!certified.ok) return { ok: false, reason: "archive_not_ready", detail: certified.detail, projectionBytes };
  const plan = store.archiveMessages(roomId, { keepNewest: ARCHIVE_KEEP_NEWEST, dryRun: true });
  if (!plan.ok) return { ok: false, reason: plan.reason ?? "archive_refused", projectionBytes };
  return { ok: true, projectionBytes, plan };
}

// One room's dry-run report: certification, then the archive plan against
// the trigger math. live:false and nothing moved — the plan comes from
// archiveRoomMessages in its default dry-run mode.
export function archiveDryRunReport(store, roomId, { capBytes = ARCHIVE_CAP_BYTES, clock = () => Date.now() } = {}) {
  const triggerBytes = archiveTriggerBytes(capBytes);
  const base = {
    roomId, dryRun: true, live: false,
    capBytes, capBasis: ARCHIVE_CAP_BASIS, triggerBytes, keepNewest: ARCHIVE_KEEP_NEWEST
  };
  const projectionBytes = roomProjectionBytes(store, roomId);
  if (projectionBytes == null) {
    return { ...base, ok: false, reason: "room_not_found", projectionBytes: null, overTrigger: false, wouldArchive: 0, plan: null };
  }
  const overTrigger = projectionBytes >= triggerBytes;
  const planned = planRoom(store, roomId, { clock });
  if (!planned.ok) {
    // The room could not be certified or the store refused the plan:
    // surface that verdict (with the step named) instead of inventing
    // numbers.
    return { ...base, ok: false, reason: planned.reason, detail: planned.detail ?? null, projectionBytes, overTrigger, wouldArchive: 0, plan: null };
  }
  return { ...base, ok: true, projectionBytes, overTrigger, wouldArchive: planned.plan.archived, plan: planned.plan };
}

export function archiveLiveOptedIn(env = globalThis.process?.env ?? {}) {
  return env?.[ARCHIVE_LIVE_ENV] === "1";
}

// One job tick over the rooms past the trigger. Default posture is
// dry-run: the tick returns a per-room report for every due room and
// moves nothing. With the env opt-in it archives at most one room — the
// largest due room that certifies — under the policy gate above.
export function runMessagesArchiveTick(store, { env = globalThis.process?.env ?? {}, capBytes = ARCHIVE_CAP_BYTES, clock = () => Date.now() } = {}) {
  const live = archiveLiveOptedIn(env);
  const rooms = roomsOverArchiveTrigger(store, capBytes);
  const reports = [];
  if (!live) {
    let wouldArchive = 0;
    for (const room of rooms) {
      const report = archiveDryRunReport(store, room.roomId, { capBytes, clock });
      reports.push(report);
      if (report.ok) wouldArchive += report.wouldArchive ?? 0;
    }
    return { rooms: rooms.length, dryRun: true, live: false, wouldArchive, archived: 0, roomId: null, reports };
  }
  let attempts = 0;
  for (const room of rooms) {
    if (attempts >= ARCHIVE_MAX_ATTEMPTS) break;
    attempts += 1;
    const planned = planRoom(store, room.roomId, { clock });
    if (!planned.ok) {
      reports.push({ roomId: room.roomId, ok: false, reason: planned.reason, detail: planned.detail ?? null, projectionBytes: room.projectionBytes });
      // A backfill-blocked room is skipped and recorded — the tick tries
      // the next-largest due room. Any other refusal ends the tick with
      // the refusal on the record.
      if (planned.detail === "backfill_blocked") continue;
      break;
    }
    if (planned.plan.archived === 0) {
      // Over the trigger on bytes but nothing may move (every old message
      // is retained by state): recorded, and the tick moves on.
      reports.push({ roomId: room.roomId, ok: true, archived: 0, note: "nothing_movable", projectionBytes: room.projectionBytes });
      continue;
    }
    const result = store.archiveMessages(room.roomId, { keepNewest: ARCHIVE_KEEP_NEWEST, dryRun: false });
    if (!result.ok) {
      reports.push({ roomId: room.roomId, ok: false, reason: result.reason ?? "archive_refused", projectionBytes: room.projectionBytes });
      break;
    }
    reports.push({
      roomId: room.roomId, ok: true, archived: result.archived, retained: result.retained,
      freedBytes: result.freedBytes, throughSeq: result.throughSeq,
      projectionBytesBefore: result.projectionBytesBefore, resultingProjectionBytes: result.resultingProjectionBytes
    });
    return { rooms: rooms.length, dryRun: false, live: true, wouldArchive: 0, archived: result.archived, roomId: room.roomId, reports };
  }
  return { rooms: rooms.length, dryRun: false, live: true, wouldArchive: 0, archived: 0, roomId: null, reports };
}
