// Issue #6 A2: room lifecycle on the server side — create a room for an
// account, archive it, and read its lifecycle for discovery.
//
// Schema v28 adds `rooms.archived_at`, a SQL-visible copy of the projection's
// `room.archivedAt` (set by the owner-only `room.archived` event in
// src/events.js). Discovery and the recovery audit read the column without
// decoding a projection; the projection stays the source of truth and
// verifyRoomLifecycle refuses a store where the two disagree. Leaving is the
// existing `member.access_changed` event targeted at the actor (the reducer
// lets a member end their own access without membership administration), so
// it needs nothing here beyond the credential revocation `command()` already
// performs when access ends.
import { EVENT_TYPES as T, PERMISSIONS, event, validId, ROOM_KINDS, roomKind, isRoomArchived } from "../src/events.js";
import { ServiceError, provisionalAccountPrefix } from "./store.mjs";

export const ROOM_LIFECYCLE_SCHEMA_VERSION = 28;
// Bounded pilot: memberships per account, counted before a room is created.
export const ACCOUNT_ROOM_LIMIT = 100;
const CREATE_FIELDS = Object.freeze(["roomId", "title", "purpose", "kind", "displayName"]);
const control = /[\x00-\x1f\x7f]/, controlExceptBreaks = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const hasArchivedColumn = db => /\barchived_at\b/.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'").get()?.sql ?? "");

// Idempotent: a re-run on a migrated store changes nothing. Pre-v28 rooms have
// no archive event, so the backfill matches no row; it is kept so the column
// and the projection agree by construction on every path through here.
export function migrateRoomLifecycleV28(store) {
  store.transaction(() => {
    if (!hasArchivedColumn(store.db)) store.db.exec("ALTER TABLE rooms ADD COLUMN archived_at TEXT");
    store.db.prepare("UPDATE rooms SET archived_at=json_extract(projection,'$.room.archivedAt') WHERE archived_at IS NOT json_extract(projection,'$.room.archivedAt')").run();
    store.storagePlatform.setVersion(store.db, ROOM_LIFECYCLE_SCHEMA_VERSION);
  });
}

// Startup audit for both the writable and the read-only open: the column exists
// and agrees with every projection. Read-only never migrates or repairs.
export function verifyRoomLifecycle(store) {
  if (!hasArchivedColumn(store.db)) throw new Error("Room lifecycle schema requires operator reconciliation");
  if (store.db.prepare("SELECT 1 FROM rooms WHERE archived_at IS NOT json_extract(projection,'$.room.archivedAt') LIMIT 1").get()) {
    throw new Error("Room lifecycle requires operator reconciliation");
  }
}

// Archive closes every write to the room: commands, history import and the
// join paths that append membership events. Reads, streams and export stay.
export function refuseArchivedWrite(state) {
  if (isRoomArchived(state)) fail(409, "room_archived", "This room is archived: reading and export stay available, nothing new is recorded");
}

export const archivedAtOf = state => (typeof state?.room?.archivedAt === "string" ? state.room.archivedAt : null);

export const ACCOUNT_ROOM_SELECT = "SELECT id, archived_at, json_extract(projection,'$.room.title') AS title, json_extract(projection,'$.room.kind') AS kind FROM rooms WHERE id=?";
export const accountRoomEntry = (row, memberId) => ({
  id: row.id, title: row.title, memberId, kind: roomKind({ kind: row.kind }),
  archived: row.archived_at !== null && row.archived_at !== undefined, archivedAt: row.archived_at ?? null
});

const accountViewer = auth => ({ accountId: auth.account.id, authEpoch: auth.account.authEpoch, sessionRevision: auth.sessionRevision, sessionBinding: auth.sessionBinding });
const text = (value, max, multiline = false) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !(multiline ? controlExceptBreaks : control).test(value);

// An account may create a room when it already administers membership
// somewhere (room owner, or `manage_members` in an active human membership):
// conversation-only guests and rooms-less accounts cannot spawn rooms in the
// pilot. The creator becomes member "owner" with every permission and is
// bound to the account like any other human membership. The client-chosen
// roomId is the idempotency key: the same request returns the same room with
// duplicate: true; a different room under that id is 409 room_exists.
export function createAccountRoom(store, token, binding, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).length !== CREATE_FIELDS.length || !CREATE_FIELDS.every(field => Object.hasOwn(request, field))) {
    fail(422, "invalid_room_request", "Supply roomId, title, purpose, kind and displayName");
  }
  const { roomId, kind } = request;
  if (!validId(roomId) || roomId.length > 64) fail(422, "invalid_room_request", "Room id must be 1 to 64 letters, digits, dots, colons, underscores or hyphens");
  if (!text(request.title, 120)) fail(422, "invalid_room_request", "Room name must be 1 to 120 characters");
  if (!text(request.purpose, 1000, true)) fail(422, "invalid_room_request", "Room purpose must be 1 to 1000 characters");
  if (!text(request.displayName, 80)) fail(422, "invalid_room_request", "Your name in the room must be 1 to 80 characters");
  if (!ROOM_KINDS.includes(kind)) fail(422, "invalid_room_request", "Room kind must be personal or organization");
  const title = request.title.trim(), purpose = request.purpose.trim(), displayName = request.displayName.trim();
  return store.transaction(() => {
    const auth = store.authenticateAccountSession(token, null, binding);
    const accountId = auth.account.id;
    const view = (memberId, duplicate) => ({ contractVersion: 1, viewer: accountViewer(auth),
      room: accountRoomEntry(store.db.prepare(ACCOUNT_ROOM_SELECT).get(roomId), memberId), duplicate });
    if (store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId)) {
      const bound = store.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, accountId);
      const state = bound ? store.room(roomId).state : null;
      const same = state && state.room.ownerId === bound.member_id && state.room.title === title && state.room.purpose === purpose
        && roomKind(state.room) === kind && state.members[bound.member_id]?.displayName === displayName;
      if (!same) fail(409, "room_exists", "That room id is already in use");
      return view(bound.member_id, true);
    }
    // A provisional account exists for exactly one room key membership and can never bind elsewhere.
    if (accountId.startsWith(provisionalAccountPrefix)) fail(403, "room_creation_denied", "This room key belongs to one room; sign in with an account key to create rooms");
    const memberships = store.db.prepare("SELECT room_id, member_id FROM member_accounts WHERE account_id=? ORDER BY room_id").all(accountId);
    if (memberships.length >= ACCOUNT_ROOM_LIMIT) fail(409, "pilot_limit", "Bounded pilot capacity reached; no room was created");
    // The same per-room check discovery uses (active human membership with its
    // invitation evidence intact), then owner or manage_members in that room.
    const administers = memberships.some(({ room_id }) => {
      let member;
      try { member = store.authenticateAccountSession(token, room_id, binding).member; }
      catch (error) { if (error.status === 403) return false; throw error; }
      return member.id === store.roomAuthority(room_id).ownerId || member.permissions.includes("manage_members");
    });
    if (!administers) fail(403, "room_creation_denied", "Creating a room requires membership administration in one of your rooms");
    const ownerId = "owner", at = new Date(store.now()).toISOString();
    store.initialize([
      event({ type: T.ROOM_CREATED, actorId: ownerId, roomId, at, data: { roomId, ownerId, title, purpose, kind } }),
      event({ type: T.MEMBER_ADDED, actorId: ownerId, roomId, at, data: { memberId: ownerId, displayName, kind: "human", permissions: [...PERMISSIONS] } })
    ]);
    store.ensureHumanAccountBinding(roomId, ownerId, accountId, "account-room-create");
    return view(ownerId, false);
  });
}
