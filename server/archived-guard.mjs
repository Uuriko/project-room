// Archived-room freeze at the registry/write choke point (EA-001 /
// EA2-002 / L05-C3).
//
// The freeze used to live only on the store's event paths: command(),
// appendSideTableEvent, importEvents and a few join paths called
// refuseArchivedWrite (server/room-lifecycle.mjs), while the durable
// work-claim registry, the bounty escrow and several store side-table
// writes never checked anything — so a claim, a funded bounty, a fresh
// credential or a session could still be recorded in an archived room.
//
// rooms.archived_at is the SQL-visible mirror of the projection's
// room.archivedAt (schema v28, server/room-lifecycle.mjs): verifyRoomLifecycle
// refuses a store where the two disagree, and command() updates both in
// the same transaction that records room.archived. Every write registry
// in this codebase is backed by the same SQLite database, so this one
// check — read from the mirror at the moment of the write — is the choke
// point every door (REST, MCP, bounty, commands) inherits.
//
// Routing (tranche-2 G8 cross-cut, coordinator verdict): the freeze
// lands at the store / side-table write layer — this guard, called at
// each store module's write-entry choke point (the work-claim registry,
// bounty escrow intake, store.insertCredential, the collab store's
// #transact funnel, the project-map store's push/pull entries, the
// invite modules' mint/create) — never as per-route patches in
// http.mjs: the funnel has no archived guards and a funnel-only fix
// covers none of the executed archived-write acceptances, because the
// side-table modules never pass through it.
//
// A registry whose database has no rooms table, or no row for the id
// (isolated state-machine fixtures, public-work namespaces, which are
// not rooms), is not an archived room and the write proceeds: the guard
// freezes rooms, not namespaces.
import { ServiceError } from "./service-error.mjs";

export const ROOM_ARCHIVED_MESSAGE = "This room is archived: reading and export stay available, nothing new is recorded";

export function archivedAtFromDb(db, roomId) {
  if (!db || typeof db.prepare !== "function" || typeof roomId !== "string") return null;
  let row;
  try { row = db.prepare("SELECT archived_at FROM rooms WHERE id=?").get(roomId); }
  catch { return null; } // no rooms table in this database: not a room-backed registry
  return typeof row?.archived_at === "string" ? row.archived_at : null;
}

export const isArchivedRoomDb = (db, roomId) => archivedAtFromDb(db, roomId) !== null;

// The 409 room_archived refusal, in the exact shape the commands route
// already uses (refuseArchivedWrite in server/room-lifecycle.mjs).
export function refuseArchivedWriteDb(db, roomId) {
  if (isArchivedRoomDb(db, roomId)) throw new ServiceError(409, "room_archived", ROOM_ARCHIVED_MESSAGE);
}
