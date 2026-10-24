// Per-room history already lives in the events table. The 4 MiB cap is the
// rooms.projection column. This census counts event bytes one room per
// wake and never reads that column into the result page. Tables are
// created on first use, outside the writer fence, and replay-skipped.

import { PILOT_LIMITS } from "./store.mjs";
import { SAFE_RECORD_ID } from "./jobs.mjs";

export const ROOM_HISTORY_CURSOR = "room_history_cursor";
export const ROOM_HISTORY_CENSUS = "room_history_census";

export function sqliteHistoryEnabled(env) {
  return env?.ROOM_SQLITE_HISTORY === "1";
}

export function ensureRoomHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${ROOM_HISTORY_CURSOR} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    after_room_id TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${ROOM_HISTORY_CENSUS} (
    room_id TEXT PRIMARY KEY,
    events INTEGER NOT NULL,
    history_bytes INTEGER NOT NULL,
    projection_bytes INTEGER NOT NULL,
    through_sequence INTEGER NOT NULL
  )`);
}

export function pageRoomHistory(db, roomId, { after = 0, limit = 50 } = {}) {
  if (!SAFE_RECORD_ID.test(roomId ?? "")) throw new TypeError("room id");
  const size = Math.min(50, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
  const start = Number.isSafeInteger(after) && after >= 0 ? after : 0;
  return db.prepare(`SELECT sequence, id, json_extract(body, '$.type') AS type, LENGTH(body) AS bytes
    FROM events WHERE room_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`).all(roomId, start, size)
    .map(row => ({ sequence: Number(row.sequence), id: row.id, type: row.type, bytes: Number(row.bytes) }));
}

export function historyCensusSummary(db) {
  ensureRoomHistory(db);
  const cap = PILOT_LIMITS.projectionBytes;
  const row = db.prepare(`SELECT
      COUNT(*) AS rooms,
      COALESCE(SUM(events), 0) AS events,
      COALESCE(SUM(history_bytes), 0) AS historyBytes,
      COALESCE(MAX(projection_bytes), 0) AS largestProjectionBytes,
      COALESCE(SUM(CASE WHEN projection_bytes >= ? THEN 1 ELSE 0 END), 0) AS roomsAtCap
    FROM ${ROOM_HISTORY_CENSUS}`).get(cap);
  return {
    rooms: Number(row?.rooms ?? 0),
    events: Number(row?.events ?? 0),
    historyBytes: Number(row?.historyBytes ?? 0),
    largestProjectionBytes: Number(row?.largestProjectionBytes ?? 0),
    roomsAtCap: Number(row?.roomsAtCap ?? 0)
  };
}

// One room, then the cursor moves. A death between the upsert and the
// cursor update repeats that room; the upsert replaces the same row.
export function refreshRoomHistoryCensus(db) {
  ensureRoomHistory(db);
  const cursor = db.prepare(`SELECT after_room_id FROM ${ROOM_HISTORY_CURSOR} WHERE singleton = 1`).get();
  const after = typeof cursor?.after_room_id === "string" ? cursor.after_room_id : "";
  const room = db.prepare("SELECT id FROM rooms WHERE id > ? ORDER BY id LIMIT 1").get(after);
  const roomId = typeof room?.id === "string" ? room.id : "";
  if (roomId) {
    const stats = db.prepare(`SELECT COUNT(*) AS events,
        COALESCE(SUM(LENGTH(body)), 0) AS history_bytes,
        COALESCE(MAX(sequence), 0) AS through_sequence
      FROM events WHERE room_id = ?`).get(roomId);
    const projection = db.prepare("SELECT LENGTH(CAST(projection AS BLOB)) AS projection_bytes FROM rooms WHERE id = ?").get(roomId);
    db.prepare(`INSERT INTO ${ROOM_HISTORY_CENSUS}
        (room_id, events, history_bytes, projection_bytes, through_sequence)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        events = excluded.events,
        history_bytes = excluded.history_bytes,
        projection_bytes = excluded.projection_bytes,
        through_sequence = excluded.through_sequence`).run(
      roomId,
      Number(stats?.events ?? 0),
      Number(stats?.history_bytes ?? 0),
      Number(projection?.projection_bytes ?? 0),
      Number(stats?.through_sequence ?? 0)
    );
  }
  db.prepare(`INSERT INTO ${ROOM_HISTORY_CURSOR} (singleton, after_room_id) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET after_room_id = excluded.after_room_id`).run(roomId);
  return { scanned: roomId ? 1 : 0, ...historyCensusSummary(db) };
}

export function noteHistoryCensus(summary) {
  if (!summary?.scanned) return;
  console.info(JSON.stringify({
    event: "room.history_census",
    scanned: summary.scanned,
    historyBytes: summary.historyBytes,
    roomsAtCap: summary.roomsAtCap
  }));
}
