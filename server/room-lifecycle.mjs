import {isCurrentRoom,readCurrentRecord,withCurrentReadContext} from './current-room-repository.mjs';
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
//
// Schema-version bookkeeping lives in exactly one place: STORE_SCHEMA_VERSION
// in server/writer-fence.mjs, advanced by the 0→34 migration chain in
// server/store.mjs (recovery.mjs requires the version to equal it exactly).
// This module owns the column and its data only — never PRAGMA user_version.
import { EVENT_TYPES as T, PERMISSIONS, event, validId, ownMember, isReservedId, ROOM_KINDS, roomKind, isRoomArchived, HISTORY_DEFAULTS_VERSION } from "../src/events.js";
import { ServiceError, provisionalAccountPrefix } from "./store.mjs";
import { accountRoomCredits, GROWTH_ROOM_ORIGIN } from "./growth-loop.mjs";
import { getRoomTemplate } from "./templates.mjs";
import { seedStarterForNewAccount, starterTitleForIntent } from "./starter-room.mjs";

export const ROOM_LIFECYCLE_MIGRATION = 28; // informational: which chain step introduced rooms.archived_at
// Bounded pilot: memberships per account, counted before a room is created.
export const ACCOUNT_ROOM_LIMIT = 100;
const CREATE_FIELDS = Object.freeze(["roomId", "title", "purpose", "kind", "displayName"]);
const control = /[\x00-\x1f\x7f]/, controlExceptBreaks = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const hasArchivedColumn = db => /\barchived_at\b/.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rooms'").get()?.sql ?? "");

// Idempotent data backfill: a re-run on a migrated store changes nothing.
// Pre-v28 rooms have no archive event, so the backfill matches no row; it is
// kept so the column and the projection agree by construction on every path
// through here. Deliberately version-neutral: the 0→34 chain in store.mjs
// owns PRAGMA user_version (see STORE_SCHEMA_VERSION in writer-fence.mjs).
export function migrateRoomLifecycleV28(store) {
  store.transaction(() => {
    if (!hasArchivedColumn(store.db)) store.db.exec("ALTER TABLE rooms ADD COLUMN archived_at TEXT");
    store.db.prepare("UPDATE rooms SET archived_at=json_extract(projection,'$.room.archivedAt') WHERE json_valid(projection) AND archived_at IS NOT json_extract(projection,'$.room.archivedAt')").run();
  });
}

// Startup audit for both the writable and the read-only open: the column exists
// and agrees with every projection. Read-only never migrates or repairs.
export function verifyRoomLifecycle(store) {
  if (!hasArchivedColumn(store.db)) throw new Error("Room lifecycle schema requires operator reconciliation");
  // #4126: a room whose projection is unreadable is quarantined at boot and
  // named in the quarantine record; it cannot agree or disagree here, so it
  // is excluded instead of throwing malformed JSON over the whole boot.
  if (store.db.prepare("SELECT 1 FROM rooms WHERE json_valid(projection) AND json_type(projection,'$.normalizedCurrent') IS NULL AND archived_at IS NOT json_extract(projection,'$.room.archivedAt') LIMIT 1").get()) {
    throw new Error("Room lifecycle requires operator reconciliation");
  }
  // The closed current carrier deliberately has no room metadata. Verify its
  // SQL lifecycle column against the independently protected singleton, not
  // against a fabricated NULL from the legacy JSON path.
  for(const row of store.db.prepare("SELECT id,archived_at FROM rooms WHERE json_valid(projection) AND json_type(projection,'$.normalizedCurrent') IS NOT NULL").iterate()) {
    const room=withCurrentReadContext(store.db,row.id,()=>readCurrentRecord(store.db,row.id,'metadata','room'));
    if(!room||room.id!==row.id||(room.archivedAt??null)!==row.archived_at)throw new Error("Room lifecycle requires operator reconciliation");
  }
}

// Archive closes every write to the room: commands, history import and the
// join paths that append membership events. Reads, streams and export stay.
// Store.command separately admits the active owner privacy exception only.
export function refuseArchivedWrite(state) {
  if (isRoomArchived(state)) fail(409, "room_archived", "This room is archived: reading, export and explicit owner erasure stay available; ordinary coordination is closed");
}

export const archivedAtOf = state => (typeof state?.room?.archivedAt === "string" ? state.room.archivedAt : null);

export const ACCOUNT_ROOM_SELECT = "SELECT id, archived_at, json_extract(projection,'$.room.title') AS title, json_extract(projection,'$.room.kind') AS kind FROM rooms WHERE id=?";
export function readAccountRoomRow(store,roomId){
  if(!isCurrentRoom(store.db,roomId))return store.db.prepare(ACCOUNT_ROOM_SELECT).get(roomId);
  return withCurrentReadContext(store.db,roomId,()=>{const room=readCurrentRecord(store.db,roomId,'metadata','room'),row=store.db.prepare('SELECT id,archived_at FROM rooms WHERE id=?').get(roomId);return row?{...row,title:room.title,kind:room.kind}:row;});
}
function creationState(store,roomId,memberId){
  if(!isCurrentRoom(store.db,roomId))return store.room(roomId).state;
  return withCurrentReadContext(store.db,roomId,()=>({room:readCurrentRecord(store.db,roomId,'metadata','room'),members:store.roomAuthority(roomId,{memberId}).members}));
}
export const accountRoomEntry = (row, memberId) => ({
  id: row.id, title: row.title, memberId, kind: roomKind({ kind: row.kind }),
  archived: row.archived_at !== null && row.archived_at !== undefined, archivedAt: row.archived_at ?? null
});

const accountViewer = auth => ({ accountId: auth.account.id, authEpoch: auth.account.authEpoch, sessionRevision: auth.sessionRevision, sessionBinding: auth.sessionBinding });
const text = (value, max, multiline = false) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !(multiline ? controlExceptBreaks : control).test(value);

// An account may create a room when it has no rooms yet — a stranger becomes
// owner of their first room — or when it already administers membership
// somewhere (room owner, or `manage_members` in an active human membership):
// conversation-only guests and plain members cannot spawn further rooms in the
// pilot. The creator becomes member "owner" with every permission and is
// bound to the account like any other human membership. The client-chosen
// roomId is the idempotency key: the same request returns the same room with
// duplicate: true; a different room under that id is 409 room_exists.
const STARTER_FIELDS = Object.freeze(["intent", "start", "templateSlug", "visibility"]);

export function createAccountRoom(store, token, binding, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || !CREATE_FIELDS.every(field => Object.hasOwn(request, field))
    || Object.keys(request).some(field => !CREATE_FIELDS.includes(field) && !STARTER_FIELDS.includes(field))) {
    fail(422, "invalid_room_request", "Supply roomId, title, purpose, kind and displayName");
  }
  if (Object.hasOwn(request, "visibility") && !["open", "private"].includes(request.visibility)) fail(422, "invalid_room_request", "visibility must be open or private");
  const { roomId, kind } = request;
  // #3013: a reserved prototype name (validId's denylist) is not a charset
  // or length failure — name the real cause so API consumers are not told
  // their letters/underscores are illegal characters.
  if (isReservedId(roomId)) fail(422, "reserved_room_id", "Room id is reserved and cannot be used; choose a different room id");
  if (!validId(roomId) || roomId.length > 64) fail(422, "invalid_room_request", "Room id must be 1 to 64 letters, digits, dots, colons, underscores or hyphens");
  if (!text(request.title, 120)) fail(422, "invalid_room_request", "Room name must be 1 to 120 characters");
  if (!text(request.purpose, 1000, true)) fail(422, "invalid_room_request", "Room purpose must be 1 to 1000 characters");
  if (!text(request.displayName, 80)) fail(422, "invalid_room_request", "Your name in the room must be 1 to 80 characters");
  if (!ROOM_KINDS.includes(kind)) fail(422, "invalid_room_request", "Room kind must be personal or organization");
  // ACT-1a: optional intent / start=1 seed Room Guide. Requests without them
  // keep the existing two-step onboarding. ACT-1b is what sends these fields.
  let intent = null;
  if (Object.hasOwn(request, "intent")) {
    if (!text(request.intent, 80)) fail(422, "invalid_room_request", "intent must be 1 to 80 characters");
    intent = request.intent.trim();
  }
  let start = false;
  if (Object.hasOwn(request, "start")) {
    if (request.start !== 1 && request.start !== true) fail(422, "invalid_room_request", "start must be 1");
    start = true;
  }
  let templateSlug = null;
  if (Object.hasOwn(request, "templateSlug")) {
    if (typeof request.templateSlug !== "string" || !getRoomTemplate(request.templateSlug)) {
      fail(422, "invalid_room_request", "templateSlug must name a room template");
    }
    templateSlug = request.templateSlug;
  }
  const wantsStarter = Boolean(intent) || start;
  let title = request.title.trim();
  if (intent) title = starterTitleForIntent(intent);
  const purpose = request.purpose.trim(), displayName = request.displayName.trim();
  return store.transaction(() => {
    const auth = store.authenticateAccountSession(token, null, binding);
    const accountId = auth.account.id;
    const view = (memberId, duplicate) => ({ contractVersion: 1, viewer: accountViewer(auth),
      room: accountRoomEntry(readAccountRoomRow(store,roomId), memberId), duplicate,
      ...(wantsStarter && isCurrentRoom(store.db,roomId) ? {starter:{workItemId:'native-starter',nextRead:{tool:'room_read_work',arguments:{workItemId:'native-starter'}}}} : {}) });
    if (store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId)) {
      const bound = store.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, accountId);
      const state = bound ? creationState(store,roomId,bound.member_id) : null;
      const same = state && state.room.ownerId === bound.member_id && state.room.title === title && state.room.purpose === purpose
        && roomKind(state.room) === kind && ownMember(state.members, bound.member_id)?.displayName === displayName;
      if (!same) fail(409, "room_exists", "That room id is already in use");
      if (request.visibility === "private" && state.room.publicPage?.enabled === true) fail(409, "room_exists", "This saved room is public. Open its owner settings to make it private; creation retry did not change visibility.");
      if (wantsStarter) seedStarterForNewAccount(store, accountId, { intent, templateSlug, roomId, ownerMemberId: bound.member_id, start, token, binding });
      return view(bound.member_id, true);
    }
    // A provisional account exists for exactly one room key membership and can never bind elsewhere.
    if (accountId.startsWith(provisionalAccountPrefix)) fail(403, "room_creation_denied", "This room key belongs to one room; sign in with an account key to create rooms");
    const memberships = store.db.prepare("SELECT room_id, member_id FROM member_accounts WHERE account_id=? ORDER BY room_id").all(accountId);
    if (memberships.length >= ACCOUNT_ROOM_LIMIT) fail(409, "pilot_limit", "Bounded pilot capacity reached; no room was created");
    if (memberships.length > 0) store.accountLogins.assertEmailVerified(accountId);
    // The same per-room check discovery uses (active human membership with its
    // invitation evidence intact), then owner or manage_members in that room.
    // No active memberships means a first room: allowed (an old, inactive
    // audit binding is not current membership). An account still in rooms keeps the
    // administration requirement for additional rooms.
    // A growth-funded room does not count as administering one: owning it
    // must not unlock the ordinary 100-room allowance.
    let foundedWithGrowth = false;
    let activeMemberships = 0;
    const administers = memberships.some(({ room_id }) => {
      let member;
      try { member = store.authenticateAccountSession(token, room_id, binding).member; }
      catch (error) { if (error.status === 403) return false; throw error; }
      activeMemberships += 1;
      const origin = store.db.prepare("SELECT origin FROM member_accounts WHERE room_id=? AND account_id=?").get(room_id, accountId)?.origin;
      if (origin === GROWTH_ROOM_ORIGIN) return false;
      return member.id === store.roomOwnerId(room_id) || member.permissions.includes("manage_members");
    });
    const naturallyAdministers = activeMemberships === 0 || administers;
    if (!naturallyAdministers) {
      const credits = accountRoomCredits(store, accountId);
      const growthRooms = store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=? AND origin=?").get(accountId, GROWTH_ROOM_ORIGIN).n;
      if (growthRooms >= credits.total) fail(403, "room_creation_denied", "Creating a room requires membership administration in one of your rooms");
      foundedWithGrowth = true;
    }
    const ownerId = "owner", at = new Date(store.now()).toISOString();
    store.initialize([
      event({ type: T.ROOM_CREATED, actorId: ownerId, roomId, at, data: { roomId, ownerId, title, purpose, kind, historyDefaultsVersion: HISTORY_DEFAULTS_VERSION } }), // PRIV-2
      event({ type: T.MEMBER_ADDED, actorId: ownerId, roomId, at, data: { memberId: ownerId, displayName, kind: "human", permissions: [...PERMISSIONS] } })
    ], {representation:'normalized-current-v1'});
    store.ensureHumanAccountBinding(roomId, ownerId, accountId, foundedWithGrowth ? GROWTH_ROOM_ORIGIN : "account-room-create");
    if (request.visibility !== "private") {
      store.command(token, roomId, {id:"creation-public-page",type:T.ROOM_PUBLIC_PAGE_SET,data:{enabled:true}}, binding);
      store.command(token, roomId, {id:"creation-open-join",type:T.ROOM_JOIN_LINK_SET,data:{enabled:true}}, binding);
    }
    if (wantsStarter) seedStarterForNewAccount(store, accountId, { intent, templateSlug, roomId, ownerMemberId: ownerId, start, token, binding });
    return view(ownerId, false);
  });
}
