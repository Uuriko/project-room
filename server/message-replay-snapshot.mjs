import { createHash } from "node:crypto";
// Replay bodies never share a SQLite row with frequently advanced certificates.
// All writes are transaction-scoped with their cursor metadata and privacy edits.
export const MESSAGE_REPLAY_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_replay_snapshots (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages_backfill_state (
  room_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY(room_id,part)
);
`;
// Keep each SQLite value below the Worker limit, without splitting surrogates.
const STATE_PART_CHARS = 600000;
const PARTS_PREFIX = "parts:";
function deleteParts(db, roomId, from = 0) {
  db.prepare('DELETE FROM messages_backfill_state WHERE room_id=? AND part>=?').run(roomId,from);
}
export function decodeMessageReplaySnapshot(db, roomId, text) {
  if (!text.startsWith(PARTS_PREFIX)) return JSON.parse(text);
  const [,count,sha] = text.split(":");
  const rows = db.prepare('SELECT part,json FROM messages_backfill_state WHERE room_id=? ORDER BY part').all(roomId);
  const joined = rows.map(row => row.json).join("");
  if (String(rows.length) !== count || rows.some((row,index) => row.part !== index) || createHash('sha256').update(joined,'utf8').digest('hex') !== sha) {
    throw new Error(`messages backfill state for ${roomId} is torn`);
  }
  return JSON.parse(joined);
}
export function readMessageReplaySnapshot(db, roomId) {
  return db.prepare('SELECT state_json FROM message_replay_snapshots WHERE room_id=?').get(roomId) ?? null;
}
export function writeMessageReplaySnapshot(db, roomId, json) {
  let stored = json;
  if (json.length > STATE_PART_CHARS) {
    const insert = db.prepare(`INSERT INTO messages_backfill_state(room_id,part,json) VALUES (?,?,?)
      ON CONFLICT(room_id,part) DO UPDATE SET json=excluded.json`);
    let part = 0;
    for (let at = 0; at < json.length;) {
      let end = Math.min(json.length,at + STATE_PART_CHARS);
      const code = json.charCodeAt(end);
      if (end < json.length && code >= 0xDC00 && code <= 0xDFFF) end -= 1;
      insert.run(roomId,part++,json.slice(at,end));
      at = end;
    }
    deleteParts(db,roomId,part);
    stored = `${PARTS_PREFIX}${part}:${createHash('sha256').update(json,'utf8').digest('hex')}`;
  } else deleteParts(db,roomId);
  db.prepare(`INSERT INTO message_replay_snapshots(room_id,state_json) VALUES (?,?)
    ON CONFLICT(room_id) DO UPDATE SET state_json=excluded.state_json`).run(roomId,stored);
}
export function discardMessageReplaySnapshot(db, roomId) {
  deleteParts(db,roomId);
  db.prepare('DELETE FROM message_replay_snapshots WHERE room_id=?').run(roomId);
}
export function migrateMessageReplaySnapshots(db) {
  db.exec(MESSAGE_REPLAY_SNAPSHOT_SCHEMA);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('messages_backfill_cursor') WHERE name='replay_event_id'").get()) {
    db.exec("ALTER TABLE messages_backfill_cursor ADD COLUMN replay_event_id TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE messages_backfill_cursor SET replay_event_id=COALESCE(
      (SELECT id FROM events WHERE room_id=messages_backfill_cursor.room_id AND sequence=messages_backfill_cursor.state_seq),'')`);
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('messages_backfill_cursor') WHERE name='state_json'").get()) return;
  db.exec(`INSERT INTO message_replay_snapshots(room_id,state_json)
    SELECT room_id,state_json FROM messages_backfill_cursor WHERE room_id<>'' AND state_json IS NOT NULL
    ON CONFLICT(room_id) DO UPDATE SET state_json=excluded.state_json`);
  db.exec('ALTER TABLE messages_backfill_cursor DROP COLUMN state_json');
}
