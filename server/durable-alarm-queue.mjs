// One alarm per Durable Object. The queue is the list; setAlarm is only the
// wake. A slice claims one row, checkpoints, and leaves the rest durable if
// the object is killed mid-run. Created on first use, outside the writer
// fence, and replay-skipped: a restored room starts this table empty.

export const DURABLE_ALARM_TABLE = "durable_alarm_queue";
export const DURABLE_ALARM_LEASE_MS = 20_000;
export const DURABLE_ALARM_RETRY_MS = 60_000;
export const DURABLE_ALARM_SLICE_GAP_MS = 25;
export const DURABLE_ALARM_DONE_TTL_MS = 24 * 60 * 60 * 1000;
export const DURABLE_ALARM_PRUNE_BATCH = 50;
export const DURABLE_ALARM_MAX_ATTEMPTS = 8;

const DEDUPE_KEY = /^[a-z0-9][a-z0-9:._-]{0,160}$/;
const KIND = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function ensureDurableAlarmQueue(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${DURABLE_ALARM_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done')),
    attempt INTEGER NOT NULL DEFAULT 0,
    cursor_json TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS durable_alarm_queue_due
    ON ${DURABLE_ALARM_TABLE} (status, run_at, id)`);
}

function cursorOf(text) {
  if (typeof text !== "string" || !text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function rowOf(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    payload: cursorOf(row.payload),
    attempt: Number(row.attempt),
    cursor: cursorOf(row.cursor_json),
    runAt: Number(row.run_at)
  };
}

export function enqueueDurableAlarm(db, { dedupeKey, kind, payload, runAt, reopen = false }, now) {
  ensureDurableAlarmQueue(db);
  if (!DEDUPE_KEY.test(dedupeKey)) throw new TypeError("bad alarm dedupe key");
  if (!KIND.test(kind)) throw new TypeError("bad alarm kind");
  const body = JSON.stringify(payload ?? {});
  if (body.length > 2000) throw new TypeError("alarm payload is too large");
  if (!Number.isSafeInteger(runAt) || !Number.isSafeInteger(now)) throw new TypeError("alarm time");
  const existing = db.prepare(`SELECT id, status FROM ${DURABLE_ALARM_TABLE} WHERE dedupe_key=?`).get(dedupeKey);
  if (existing && existing.status !== "done") return { id: Number(existing.id), created: false };
  if (existing && existing.status === "done") {
    if (!reopen) return { id: Number(existing.id), created: false, done: true };
    db.prepare(`UPDATE ${DURABLE_ALARM_TABLE}
      SET status='queued', kind=?, payload=?, run_at=?, attempt=0, cursor_json=NULL, lease_until=NULL, updated_at=?
      WHERE id=?`).run(kind, body, runAt, now, existing.id);
    return { id: Number(existing.id), created: false, reopened: true };
  }
  db.prepare(`INSERT INTO ${DURABLE_ALARM_TABLE}
    (dedupe_key, kind, payload, run_at, status, attempt, cursor_json, lease_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?)`).run(dedupeKey, kind, body, runAt, now, now);
  return { id: Number(db.prepare("SELECT last_insert_rowid() AS id").get().id), created: true };
}

export function recoverExpiredAlarms(db, now) {
  ensureDurableAlarmQueue(db);
  return db.prepare(`UPDATE ${DURABLE_ALARM_TABLE}
    SET status='queued', lease_until=NULL, updated_at=?
    WHERE status='running' AND lease_until IS NOT NULL AND lease_until <= ?
    RETURNING id`).all(now, now).length;
}

export function claimDueAlarm(db, now, leaseMs = DURABLE_ALARM_LEASE_MS) {
  ensureDurableAlarmQueue(db);
  const rows = db.prepare(`UPDATE ${DURABLE_ALARM_TABLE}
    SET status='running', attempt=attempt+1, lease_until=?, updated_at=?
    WHERE id = (
      SELECT id FROM ${DURABLE_ALARM_TABLE}
      WHERE status='queued' AND run_at <= ?
      ORDER BY run_at, id
      LIMIT 1
    )
    RETURNING id, dedupe_key, kind, payload, attempt, cursor_json, run_at`).all(now + leaseMs, now, now);
  return rowOf(rows[0]);
}

export function checkpointDurableAlarm(db, id, cursor, now, leaseMs = DURABLE_ALARM_LEASE_MS) {
  const body = JSON.stringify(cursor ?? {});
  const rows = db.prepare(`UPDATE ${DURABLE_ALARM_TABLE}
    SET cursor_json=?, lease_until=?, updated_at=?
    WHERE id=? AND status='running'
    RETURNING id`).all(body, now + leaseMs, now, id);
  if (!rows.length) throw new Error("alarm checkpoint lost the lease");
}

export function completeDurableAlarm(db, id, cursor, now) {
  const body = JSON.stringify(cursor ?? {});
  db.prepare(`UPDATE ${DURABLE_ALARM_TABLE}
    SET status='done', cursor_json=?, lease_until=NULL, updated_at=?
    WHERE id=? AND status='running'`).run(body, now, id);
}

export function retryDurableAlarm(db, id, cursor, now, delayMs = DURABLE_ALARM_RETRY_MS) {
  const body = JSON.stringify(cursor ?? {});
  db.prepare(`UPDATE ${DURABLE_ALARM_TABLE}
    SET status='queued', cursor_json=?, lease_until=NULL, run_at=?, updated_at=?
    WHERE id=? AND status='running'`).run(body, now + delayMs, now, id);
}

export function nextDurableAlarmAt(db) {
  ensureDurableAlarmQueue(db);
  const row = db.prepare(`SELECT MIN(run_at) AS at FROM ${DURABLE_ALARM_TABLE} WHERE status='queued'`).get();
  return Number.isFinite(row?.at) ? Number(row.at) : null;
}

export function pruneDoneAlarms(db, now) {
  ensureDurableAlarmQueue(db);
  db.prepare(`DELETE FROM ${DURABLE_ALARM_TABLE} WHERE id IN (
    SELECT id FROM ${DURABLE_ALARM_TABLE}
    WHERE status='done' AND updated_at < ?
    ORDER BY id LIMIT ?
  )`).run(now - DURABLE_ALARM_DONE_TTL_MS, DURABLE_ALARM_PRUNE_BATCH);
}

// One wake. The caller arms the next alarm from nextAt. A throw from run
// is stored as a retry and returned, not lost: the row is queued again
// before this function returns.
export async function runDurableAlarmSlice({
  db, now, leaseMs = DURABLE_ALARM_LEASE_MS, retryMs = DURABLE_ALARM_RETRY_MS, run
}) {
  if (typeof run !== "function") throw new TypeError("alarm slice needs a run function");
  ensureDurableAlarmQueue(db);
  pruneDoneAlarms(db, now);
  const recovered = recoverExpiredAlarms(db, now);
  const item = claimDueAlarm(db, now, leaseMs);
  if (!item) return { recovered, item: null, ran: false, failed: false, nextAt: nextDurableAlarmAt(db) };
  if (item.cursor.phase === "finished") {
    completeDurableAlarm(db, item.id, item.cursor, now);
    return { recovered, item, ran: false, failed: false, skipped: "finished", nextAt: nextDurableAlarmAt(db) };
  }
  if (item.attempt > DURABLE_ALARM_MAX_ATTEMPTS) {
    const cursor = { phase: "poisoned" };
    completeDurableAlarm(db, item.id, cursor, now);
    return { recovered, item, ran: false, failed: false, skipped: "poisoned", nextAt: nextDurableAlarmAt(db) };
  }
  checkpointDurableAlarm(db, item.id, { phase: "started" }, now, leaseMs);
  let result;
  try {
    result = await run(item);
  } catch (error) {
    retryDurableAlarm(db, item.id, { phase: "started" }, now, retryMs);
    return { recovered, item, ran: true, failed: true, error, nextAt: nextDurableAlarmAt(db) };
  }
  if (result?.ok === false) {
    retryDurableAlarm(db, item.id, { phase: "started" }, now, retryMs);
    return { recovered, item, ran: true, failed: true, result, nextAt: nextDurableAlarmAt(db) };
  }
  const finished = { phase: "finished" };
  checkpointDurableAlarm(db, item.id, finished, now, leaseMs);
  completeDurableAlarm(db, item.id, finished, now);
  return { recovered, item, ran: true, failed: false, result, nextAt: nextDurableAlarmAt(db) };
}
