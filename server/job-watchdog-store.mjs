// Progress copied off the room object. The room can die with its alarm;
// this table is what GET /api/health/jobs reads instead, and what decides
// to setAlarm again. One subject today: the pilot object.

export const WATCHDOG_SUBJECT = "invite-only-pilot";
export const WATCHDOG_NAME = "job-watchdog";
export const WATCHDOG_STALL_MS = 60_000;
export const WATCHDOG_PERIOD_MS = 30_000;
export const WATCHDOG_REBOOT_BATCH = 5;
export const WATCHDOG_RECEIPT_LIMIT = 20;
const SNAPSHOT_LIMIT = 16_000;
const HISTORY_KEYS = ["rooms", "events", "historyBytes", "largestProjectionBytes", "roomsAtCap"];

export function jobWatchdogEnabled(env) {
  return env?.ROOM_JOB_WATCHDOG === "1" && typeof env?.JOB_WATCHDOG?.getByName === "function";
}

export function ensureWatchdogStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS watchdog_subjects (
    object_name TEXT PRIMARY KEY,
    progress_at INTEGER NOT NULL,
    alarm_at INTEGER,
    reboot_count INTEGER NOT NULL DEFAULT 0,
    last_reboot_at INTEGER,
    jobs_json TEXT NOT NULL,
    receipts_json TEXT NOT NULL,
    history_json TEXT NOT NULL
  )`);
}

function containsRecordId(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRecordId);
  for (const [key, child] of Object.entries(value)) {
    if (key === "recordId") return true;
    if (containsRecordId(child)) return true;
  }
  return false;
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function sanitizeReceipt(value) {
  if (!value || typeof value !== "object") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(value.job ?? "")) return null;
  if (!Number.isSafeInteger(value.at) || !Number.isSafeInteger(value.attempt) || value.attempt < 0) return null;
  if (typeof value.ok !== "boolean") return null;
  return { job: value.job, at: value.at, ok: value.ok, attempt: value.attempt };
}

export function sanitizeHistory(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of HISTORY_KEYS) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  return out;
}

export function recordWatchdogBeat(db, beat, now) {
  ensureWatchdogStore(db);
  if (beat?.objectName !== WATCHDOG_SUBJECT) throw new TypeError("unknown watchdog subject");
  if (!Number.isSafeInteger(beat.progressAt)) throw new TypeError("progressAt");
  const alarmAt = Number.isSafeInteger(beat.alarmAt) ? beat.alarmAt : null;
  let snapshot = beat.snapshot && typeof beat.snapshot === "object" && !Array.isArray(beat.snapshot) ? beat.snapshot : {};
  if (containsRecordId(snapshot)) snapshot = {};
  let jobs = JSON.stringify(snapshot);
  if (jobs.length > SNAPSHOT_LIMIT) jobs = "{}";
  const prior = db.prepare("SELECT receipts_json, history_json, reboot_count FROM watchdog_subjects WHERE object_name=?").get(WATCHDOG_SUBJECT);
  const receipts = parseJson(prior?.receipts_json, []);
  const list = Array.isArray(receipts) ? receipts.filter(item => sanitizeReceipt(item)) : [];
  const receipt = sanitizeReceipt(beat.receipt);
  if (receipt) list.push(receipt);
  const history = beat.history == null ? (prior?.history_json ?? "{}") : JSON.stringify(sanitizeHistory(beat.history));
  db.prepare(`INSERT INTO watchdog_subjects
      (object_name, progress_at, alarm_at, reboot_count, last_reboot_at, jobs_json, receipts_json, history_json)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(object_name) DO UPDATE SET
      progress_at=excluded.progress_at,
      alarm_at=excluded.alarm_at,
      jobs_json=excluded.jobs_json,
      receipts_json=excluded.receipts_json,
      history_json=excluded.history_json`).run(
    WATCHDOG_SUBJECT, beat.progressAt, alarmAt, Number(prior?.reboot_count ?? 0), jobs,
    JSON.stringify(list.slice(-WATCHDOG_RECEIPT_LIMIT)), history
  );
}

export function planWatchdogReboots(db, now, { stallMs = WATCHDOG_STALL_MS, limit = WATCHDOG_REBOOT_BATCH } = {}) {
  ensureWatchdogStore(db);
  return db.prepare(`SELECT object_name AS objectName FROM watchdog_subjects
    WHERE progress_at <= ?
      AND (alarm_at IS NULL OR alarm_at <= ?)
      AND (last_reboot_at IS NULL OR last_reboot_at <= ?)
    ORDER BY progress_at
    LIMIT ?`).all(now - stallMs, now, now - stallMs, limit).map(row => row.objectName);
}

export function markRebooted(db, objectName, now) {
  if (objectName !== WATCHDOG_SUBJECT) return;
  db.prepare(`UPDATE watchdog_subjects
    SET reboot_count=reboot_count+1, last_reboot_at=?
    WHERE object_name=?`).run(now, objectName);
}

function iso(ms) {
  return Number.isSafeInteger(ms) ? new Date(ms).toISOString() : null;
}

export function readWatchdogHealth(db, now, { stallMs = WATCHDOG_STALL_MS } = {}) {
  ensureWatchdogStore(db);
  const row = db.prepare("SELECT * FROM watchdog_subjects WHERE object_name=?").get(WATCHDOG_SUBJECT);
  if (!row) {
    return {
      schema: "room.job-health/1", status: "unavailable", source: "watchdog", jobs: [],
      watchdog: { progressAt: null, stalled: true, rebootCount: 0, receipts: [], history: null }
    };
  }
  const snapshot = parseJson(row.jobs_json, {});
  const stalled = now - Number(row.progress_at) > stallMs;
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.map(job => {
    if (!stalled || !job || job.status === "disabled" || job.status === "failing") return job;
    return { ...job, stale: true, status: "stale" };
  }) : [];
  let status = typeof snapshot.status === "string" ? snapshot.status : "unavailable";
  if (stalled && (status === "ok" || status === "degraded")) status = "stale";
  const history = sanitizeHistory(parseJson(row.history_json, {}));
  const receipts = parseJson(row.receipts_json, []);
  return {
    schema: snapshot.schema ?? "room.job-health/1",
    status,
    generatedAt: iso(now),
    source: "watchdog",
    jobs,
    watchdog: {
      progressAt: iso(Number(row.progress_at)),
      alarmAt: iso(row.alarm_at == null ? null : Number(row.alarm_at)),
      stalled,
      rebootCount: Number(row.reboot_count ?? 0),
      receipts: Array.isArray(receipts) ? receipts.slice(-WATCHDOG_RECEIPT_LIMIT) : [],
      history: Object.keys(history).length ? history : null
    }
  };
}
