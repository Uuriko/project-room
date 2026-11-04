import { ASSIGNMENT_DEADLINE_DEFAULTS, assignmentDeadlinesConfigured, assignmentDeadlinesEnabled, runAssignmentDeadlines } from "./assignment-deadlines.mjs";

// Persistent next-rung schedule for assignment deadlines (#5858 successor).
//
// One row per room: the earliest future moment a deadline rung (reping,
// escalate, free, lease warn) becomes due in that room. The row is rewritten
// after every committed event in the room (the work lifecycle: proposed,
// accepted, superseded, claimed ...) and after every scheduler run, so it
// survives isolate eviction and restarts. The "assignment-deadlines" job's
// nextDueAt is MIN(due_at), so the Durable Object alarm is armed for the
// earliest pending rung even when no other job is waiting, and re-armed
// after each fire by the normal alarm path. Nothing is polled on a fixed
// cadence and no room is enumerated or hydrated to find the next alarm.
//
// ROOM_ASSIGNMENT_DEADLINES (default off). Off, unset, 0 or "off" never
// touch the table: no write, no read, no room enumeration.

const TABLE = "assignment_deadline_schedule";
const RUN_BATCH = 25;

export function ensureDeadlineScheduleTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (room_id TEXT PRIMARY KEY, due_at INTEGER NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_due ON ${TABLE}(due_at)`);
}

function ms(value) { const t = Date.parse(value); return Number.isFinite(t) ? t : null; }

// Earliest rung threshold strictly after `after` for one work item, or null.
export function nextRungAt(item, after, options = {}) {
  const opts = { ...ASSIGNMENT_DEADLINE_DEFAULTS, ...options };
  const out = [];
  if (item?.state === "proposed" && !item.supersededBy && item.accountableMemberId) {
    const created = ms(item.createdAt);
    if (created !== null) out.push(created + opts.ackWithinMs, created + opts.escalateAfterMs, created + opts.freeAfterMs);
  } else {
    const expires = ms(item?.claim?.leaseExpiresAt ?? item?.leaseExpiresAt);
    if (expires !== null && (item?.claim?.holderId ?? item?.holderId)) out.push(expires - opts.leaseWarnBeforeMs);
  }
  const future = out.filter(t => t > after);
  return future.length ? Math.min(...future) : null;
}

export function roomNextRungAt(items, after, options = {}) {
  let best = null;
  for (const item of items ?? []) {
    const t = nextRungAt(item, after, options);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

function existingDue(db, roomId) {
  try { return db.prepare(`SELECT due_at FROM ${TABLE} WHERE room_id=?`).get(roomId)?.due_at ?? null; }
  catch { return null; }
}

// Recompute one room's row. `keepOverdue` preserves a row already due and not
// yet processed (an event landing between the rung and the alarm must not
// push the alarm past the rung it was armed for).
export function rescheduleRoom(store, roomId, nowMs = Date.now(), { keepOverdue = true } = {}) {
  const db = store?.db;
  if (!db?.prepare || !assignmentDeadlinesEnabled(store?.featureEnv, roomId)) return null;
  ensureDeadlineScheduleTable(db);
  const prior = existingDue(db, roomId);
  if (keepOverdue && prior !== null && prior <= nowMs) return prior;
  const items = Object.values(store.room(roomId)?.state?.workItems ?? {});
  const due = roomNextRungAt(items, nowMs);
  if (due === null) db.prepare(`DELETE FROM ${TABLE} WHERE room_id=?`).run(roomId);
  else db.prepare(`INSERT INTO ${TABLE}(room_id, due_at) VALUES(?, ?) ON CONFLICT(room_id) DO UPDATE SET due_at=excluded.due_at`).run(roomId, due);
  return due;
}

// The job's next due time: one indexed MIN read, null when off or empty.
export function deadlineScheduleDueAt(store, env = store?.featureEnv) {
  if (!assignmentDeadlinesConfigured(env) || !store?.db?.prepare) return null;
  try {
    const due = store.db.prepare(`SELECT MIN(due_at) AS due FROM ${TABLE}`).get()?.due;
    return due == null ? null : Number(due);
  } catch { return null; }
}

// One scheduler fire: post each due room's current rung (idempotent per rung
// key), then move the room's row to its next rung, or delete it.
export function runDeadlineSchedule(store, nowMs = Date.now(), { batch = RUN_BATCH } = {}) {
  if (!assignmentDeadlinesConfigured(store?.featureEnv) || !store?.db?.prepare) return { rooms: 0, posted: 0 };
  let rows = [];
  try { rows = store.db.prepare(`SELECT room_id AS roomId FROM ${TABLE} WHERE due_at<=? ORDER BY due_at LIMIT ?`).all(nowMs, batch); }
  catch { return { rooms: 0, posted: 0 }; }
  let posted = 0;
  for (const { roomId } of rows) {
    if (!assignmentDeadlinesEnabled(store.featureEnv, roomId)) {
      store.db.prepare(`DELETE FROM ${TABLE} WHERE room_id=?`).run(roomId);
      continue;
    }
    posted += runAssignmentDeadlines(store, roomId, nowMs).length;
    rescheduleRoom(store, roomId, nowMs, { keepOverdue: false });
  }
  return { rooms: rows.length, posted };
}

// Keep every room's row current after each committed event. Installed once
// per store; a no-op while the flag is off. Never throws into a commit.
export function installDeadlineScheduler(store, { now = () => Date.now() } = {}) {
  if (!store?.onEventAppended || store.__deadlineSchedulerInstalled) return () => {};
  store.__deadlineSchedulerInstalled = true;
  return store.onEventAppended(roomId => {
    if (!assignmentDeadlinesEnabled(store.featureEnv, roomId)) return;
    try { rescheduleRoom(store, roomId, now()); }
    catch (error) { console.error(`assignment deadline schedule failed: ${error?.message ?? "failed"}`); }
  });
}
