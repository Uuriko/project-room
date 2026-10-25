// Stale writer-permit resets (QA11-7). An outermost transaction that finds
// room_writer_permit already at the writer version restores permit 0. This
// table counts those heals. It is created on the first reset, never by
// schema install, and is skipped on export replay and restore so one
// object's counter is not copied onto another.

const TABLE = "room_writer_permit_heal";

export function noteWriterPermitReset(db, at = new Date().toISOString()) {
  const sql = db.storage?.sql;
  if (!sql || typeof sql.exec !== "function") return;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    reset_count INTEGER NOT NULL,
    last_reset_at TEXT NOT NULL
  )`);
  sql.exec(
    `INSERT INTO ${TABLE} (singleton, reset_count, last_reset_at) VALUES (1, 1, ?)
     ON CONFLICT(singleton) DO UPDATE SET reset_count = reset_count + 1, last_reset_at = excluded.last_reset_at`,
    at
  );
}

export function readWriterPermitHeal(db) {
  const empty = { count: 0, lastResetAt: null };
  if (!db || typeof db.prepare !== "function") return empty;
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
  if (!exists) return empty;
  const row = db.prepare(`SELECT reset_count AS count, last_reset_at AS lastResetAt FROM ${TABLE} WHERE singleton=1`).get();
  if (!row || !Number.isFinite(Number(row.count))) return empty;
  return { count: Number(row.count), lastResetAt: typeof row.lastResetAt === "string" ? row.lastResetAt : null };
}
