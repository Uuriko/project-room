// Replay bodies never share a SQLite row with frequently advanced certificates.
// All writes are transaction-scoped with their cursor metadata and privacy edits.
export const MESSAGE_REPLAY_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_replay_snapshots (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  state_json TEXT NOT NULL
);
`;
export function readMessageReplaySnapshot(db, roomId) {
  return db.prepare('SELECT state_json FROM message_replay_snapshots WHERE room_id=?').get(roomId) ?? null;
}
export function writeMessageReplaySnapshot(db, roomId, json) {
  db.prepare(`INSERT INTO message_replay_snapshots(room_id,state_json) VALUES (?,?)
    ON CONFLICT(room_id) DO UPDATE SET state_json=excluded.state_json`).run(roomId,json);
}
export function discardMessageReplaySnapshot(db, roomId) {
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
