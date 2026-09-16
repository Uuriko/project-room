// Read a Room's history out of a real store, read-only.
//
// The growth harness previously accepted only a JSON array of events, which meant
// every number it produced came from a fixture. The Room persists: server/store.mjs
// opens a SQLite database, and the live Worker binds a SQLite-backed Durable Object.
// This module reads that database so the same harness can report on actual history.
//
// Strictly read-only. It opens the file with readOnly: true, runs SELECTs only, and
// never writes, migrates or upgrades. Pointing an older writer at current data is
// explicitly forbidden in this repo, and nothing here is a writer at all.

import { DatabaseSync } from "node:sqlite";

// The columns this module depends on. tests/room-export.test.js pins these against
// the CREATE TABLE text in server/store.mjs so a schema change fails loudly here
// rather than producing a confidently empty report.
export const REQUIRED_COLUMNS = Object.freeze({
  events: ["room_id", "sequence", "id", "body"],
  rooms: ["id", "sequence", "projection"],
  membership_invitations: [
    "id", "room_id", "intended_member_id", "intended_role", "issuer_member_id",
    "created_at", "expires_at", "status", "accepted_at", "joined_event_id"
  ]
});

export function openRoomDatabase(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Room ids present in the store, most events first, so the busiest room is the obvious default. */
export function listRooms(db) {
  if (!hasTable(db, "rooms")) return [];
  return db.prepare(`
    SELECT r.id AS id, (SELECT COUNT(*) FROM events e WHERE e.room_id = r.id) AS events
    FROM rooms r ORDER BY events DESC, r.id
  `).all().map((row) => ({ id: row.id, events: Number(row.events) }));
}

/** The full event log for one room, in sequence order, ready for replay(). */
export function readEvents(db, roomId) {
  if (!hasTable(db, "events")) return [];
  const rows = db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(roomId);
  const events = [];
  for (const row of rows) {
    try {
      events.push(JSON.parse(row.body));
    } catch {
      // A body that will not parse is a corrupt row, not a reason to abandon the
      // history. Skipping it is visible downstream as a shorter log.
    }
  }
  return events;
}

/**
 * Invitation snapshot records for one room, shaped for server/invitation-funnel.mjs.
 * Returns every column, including the private ones, because the funnel is what
 * decides which fields may be emitted. Nothing here is printed directly.
 */
export function readInvitations(db, roomId) {
  if (!hasTable(db, "membership_invitations")) return [];
  return db.prepare("SELECT * FROM membership_invitations WHERE room_id=?").all(roomId);
}

/** Everything the growth harness needs from one store, in one call. */
export function exportRoom(path, { roomId = null } = {}) {
  const db = openRoomDatabase(path);
  try {
    const rooms = listRooms(db);
    if (!rooms.length) return { rooms: [], roomId: null, events: [], invitations: [] };
    const chosen = roomId ?? rooms[0].id;
    if (!rooms.some((room) => room.id === chosen)) {
      throw new Error(`No room "${chosen}" in this store. Available: ${rooms.map((room) => room.id).join(", ")}`);
    }
    return { rooms, roomId: chosen, events: readEvents(db, chosen), invitations: readInvitations(db, chosen) };
  } finally {
    db.close();
  }
}
