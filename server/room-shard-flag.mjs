// ROOM_PER_ROOM_OBJECTS is off unless the env value is exactly "1".
// Unset, "0", and any other string keep invite-only-pilot as the only home.
// The storage_home column is added only when that flag is on. A default
// deploy does not alter the pilot schema.

export function perRoomObjectsEnabled(env) {
  return env?.ROOM_PER_ROOM_OBJECTS === "1";
}

export function storageHomeColumnPresent(db) {
  return db.prepare("PRAGMA table_info(rooms)").all().some(column => column.name === "storage_home");
}

// Missing column, missing row, and any value other than "room" read as pilot.
export function readStorageHome(db, roomId) {
  if (!storageHomeColumnPresent(db)) return "pilot";
  const row = db.prepare("SELECT storage_home FROM rooms WHERE id = ?").get(roomId);
  return row?.storage_home === "room" ? "room" : "pilot";
}

export function ensureStorageHomeIfEnabled(env, db) {
  if (!perRoomObjectsEnabled(env)) return { changed: false };
  if (storageHomeColumnPresent(db)) return { changed: false };
  db.exec("ALTER TABLE rooms ADD COLUMN storage_home TEXT NOT NULL DEFAULT 'pilot'");
  return { changed: true };
}
