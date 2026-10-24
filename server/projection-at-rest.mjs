import { hydrateWorkItems, referenceWorkItems } from "./work-repository.mjs";
import { isMessageEntityRef, referenceMessageEntities, hydrateMessageEntities } from "./message-entity-projection.mjs";
// Phase 1a: message bodies at rest outside the room projection row.
//
// The reducer, the cache and every reader keep full message bodies in
// memory. Only the stored row changes: a message body at or above
// BODY_AT_REST_MIN_CHARS is replaced by `bodyRef` (its sha256) and the text
// is kept once in projection_bodies, keyed by content. Rows are immutable,
// so a write that is later rolled back or skipped can never change what an
// existing bodyRef means. The serializer itself deletes every body the
// new stored projection no longer references, in the same transaction,
// so deleted, redacted and purged text does not outlive the projection
// that held it. (WRITE-PATH-WINS win 4: this used to be an AFTER UPDATE
// trigger running json_each over the whole projection on every rooms
// write; the serializer already walks the messages and knows the
// referenced set, so the release is a set difference over the sha index
// instead of a second full-projection parse in SQL.)
//
// Rollout: hydration is always on. Slimming is on only when the store was
// opened with bodiesAtRest (ROOM_BODIES_AT_REST=1). Turning it off makes the
// next write of each room store full bodies again; store.rehydrateAllProjections()
// does that for every room at once, in one transaction, which an older build
// needs before a rollback. Take a backup first, as for any rollback.
import { createHash } from "node:crypto";

// 256, not 512 (2026-10-07): with bodies at rest on, muse-room's projection
// still grew ~350 B/event because 38% of recent bodies are 256-511 chars and
// stayed inline. At 256 those move to projection_bodies too: ~317 KB freed on
// the next write and inline body growth per message roughly halved.
export const BODY_AT_REST_MIN_CHARS = 256;

export const PROJECTION_BODIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_bodies (
  room_id TEXT NOT NULL,
  sha TEXT NOT NULL CHECK(length(sha)=64),
  body TEXT NOT NULL,
  PRIMARY KEY(room_id, sha)
);
CREATE TRIGGER IF NOT EXISTS projection_bodies_room_gone AFTER DELETE ON rooms
BEGIN
  DELETE FROM projection_bodies WHERE room_id=OLD.id;
END;`;

// WRITE-PATH-WINS win 4: rooms this process has seen holding body rows.
// The serializer only pays the release scan for those rooms; hydration
// (which reads the stored refs) and the serializer's own inserts set the
// mark, and every projection write path loads the room first, so a room
// with rows is always marked before its next write in this process.
const bodyRoomMarks = new WeakMap();
function markedRooms(db) {
  let rooms = bodyRoomMarks.get(db);
  if (!rooms) { rooms = new Set(); bodyRoomMarks.set(db, rooms); }
  return rooms;
}

// Swap one key for another in place, so key order (and so any byte-level
// comparison of the stored row) is unchanged by a round trip.
function renameKey(object, from, to, value) {
  const out = {};
  for (const [key, current] of Object.entries(object)) {
    if (key === from) out[to] = value;
    else out[key] = current;
  }
  return out;
}

const shaOf = body => createHash("sha256").update(body, "utf8").digest("hex");

// Pure memo: re-hashing every large body on every write is the main cost of
// the serializer. A string comparison is cheaper and cannot be wrong.
const hashMemo = new WeakMap();
function memoFor(db, roomId) {
  let rooms = hashMemo.get(db);
  if (!rooms) { rooms = new Map(); hashMemo.set(db, rooms); }
  let memo = rooms.get(roomId);
  if (!memo) { memo = new Map(); rooms.set(roomId, memo); }
  return memo;
}
const statements = new WeakMap();

function prepared(db) {
  let hit = statements.get(db);
  if (!hit) {
    hit = {
      known: db.prepare("SELECT sha FROM projection_bodies WHERE room_id=?"),
      insert: db.prepare("INSERT OR IGNORE INTO projection_bodies(room_id, sha, body) VALUES(?,?,?)"),
      read: db.prepare("SELECT sha, body FROM projection_bodies WHERE room_id=?"),
      release: db.prepare("DELETE FROM projection_bodies WHERE room_id=? AND sha=?")
    };
    statements.set(db, hit);
  }
  return hit;
}

const slimmable = message => message && typeof message.body === "string"
  && message.body.length >= BODY_AT_REST_MIN_CHARS && !("bodyRef" in message);

// Phase 1b: the reducer writes workItemId, replyToId and toMemberId as three
// adjacent nulls on almost every message (~53 bytes of 231). At rest they
// become one marker key in the position of the first of them. The inverse is
// exact: key order and values come back byte for byte, and a message that does
// not carry exactly that run (or that already has the marker) is left alone.
export const NULL_ENVELOPE_KEY = "_nul";
const NULL_RUN = ["workItemId", "replyToId", "toMemberId"];
const nullRunAt = keys => keys.findIndex((key, index) => key === NULL_RUN[0] && NULL_RUN.every((name, offset) => keys[index + offset] === name));
const nullEnvelope = message => {
  if (!message || typeof message !== "object" || Array.isArray(message) || NULL_ENVELOPE_KEY in message) return false;
  return NULL_RUN.every(name => message[name] === null) && nullRunAt(Object.keys(message)) >= 0;
};
const hasMarker = message => message && typeof message === "object" && message[NULL_ENVELOPE_KEY] === 1;
function slimEnvelope(message) {
  const out = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === NULL_RUN[0]) out[NULL_ENVELOPE_KEY] = 1;
    else if (!NULL_RUN.includes(key)) out[key] = value;
  }
  return out;
}
function restoreEnvelope(message) {
  const out = {};
  for (const [key, value] of Object.entries(message)) {
    if (key === NULL_ENVELOPE_KEY && value === 1) for (const name of NULL_RUN) out[name] = null;
    else out[key] = value;
  }
  return out;
}

// Delete every body row the projection about to be stored no longer
// references (win 4, replacing the json_each trigger). `referenced` is the
// set of bodyRef shas in the new stored text. Callers run this in the same
// transaction as the rooms write, so a rolled-back write rolls the
// release back too — exactly the trigger's atomicity.
function releaseUnreferencedBodies(db, roomId, referenced) {
  const { known, release } = prepared(db);
  let remaining = 0;
  for (const row of known.all(roomId)) {
    if (referenced.has(row.sha)) { remaining += 1; continue; }
    release.run(roomId, row.sha);
  }
  if (remaining || referenced.size) markedRooms(db).add(roomId);
  else markedRooms(db).delete(roomId);
}

// The only way a room projection is turned into the text stored in
// rooms.projection. With enabled=false the output is JSON.stringify(state),
// byte for byte, apart from rehydrating any bodyRef a raw-read state carries.
export function storedProjection(db, roomId, state, options = {}) {
  return serializeProjection(db, roomId, referenceWorkItems(db, roomId, state, { enabled: options.workEntities }), options);
}
function serializeProjection(db, roomId, state, { enabled = false, messageEntities = false, pendingMessageIds = [] } = {}) {
  if (state?.messages?.some(isMessageEntityRef)) state = { ...state, messages: hydrateMessageEntities(db,roomId,state.messages) };
  if (messageEntities && Array.isArray(state?.messages)) {
    if (state.messages.some(message => typeof message?.bodyRef === "string" || hasMarker(message))) {
      const hydrated = hydrateProjection(db, roomId, state, { workEntities: false });
      if (hydrated.missing.length) throw new Error("projection_corrupt: missing message body");
      state = hydrated.state;
    }
    const messages = referenceMessageEntities(db,roomId,state.messages,pendingMessageIds);
    if (markedRooms(db).has(roomId)) releaseUnreferencedBodies(db,roomId,new Set());
    return JSON.stringify({...state,messages});
  }
  const messages = Array.isArray(state?.messages) ? state.messages : null;
  if (!messages) return JSON.stringify(state);
  const carriesRefs = messages.some(message => message && typeof message.bodyRef === "string" || hasMarker(message));
  if (!enabled && !carriesRefs) {
    // Full bodies are about to be stored, so any body rows the room still
    // holds are unreferenced by definition. Only rooms this process has
    // seen holding rows pay the scan (a write always follows a load,
    // which marks the room in hydrateProjection).
    if (markedRooms(db).has(roomId)) releaseUnreferencedBodies(db, roomId, new Set());
    return JSON.stringify(state);
  }
  if (!enabled) {
    const text = JSON.stringify(hydrateProjection(db, roomId, structuredClone(state), { workEntities: false }).state);
    releaseUnreferencedBodies(db, roomId, new Set());
    return text;
  }
  if (!messages.some(message => slimmable(message) || nullEnvelope(message))) {
    const referenced = new Set();
    for (const message of messages) if (message && typeof message.bodyRef === "string") referenced.add(message.bodyRef);
    if (referenced.size || markedRooms(db).has(roomId)) releaseUnreferencedBodies(db, roomId, referenced);
    return JSON.stringify(state);
  }
  const { known, insert } = prepared(db);
  const present = new Set(known.all(roomId).map(row => row.sha));
  const memo = memoFor(db, roomId), seen = new Map();
  const slim = messages.map(original => {
    const message = nullEnvelope(original) ? slimEnvelope(original) : original;
    if (!slimmable(original)) return message;
    const cached = memo.get(message.id);
    const sha = cached && cached.body === message.body ? cached.sha : shaOf(message.body);
    seen.set(message.id, { body: message.body, sha });
    if (!present.has(sha)) { insert.run(roomId, sha, message.body); present.add(sha); }
    return renameKey(message, "body", "bodyRef", sha);
  });
  hashMemo.get(db).set(roomId, seen);
  const referenced = new Set();
  for (const message of slim) if (message && typeof message.bodyRef === "string") referenced.add(message.bodyRef);
  // The `present` set above is the pre-write index (plus this write's
  // inserts, all of which are referenced), so the release diff needs no
  // second scan of the table.
  const { release } = prepared(db);
  let remaining = 0;
  for (const sha of present) {
    if (referenced.has(sha)) { remaining += 1; continue; }
    release.run(roomId, sha);
  }
  if (remaining || referenced.size) markedRooms(db).add(roomId);
  else markedRooms(db).delete(roomId);
  return JSON.stringify({ ...state, messages: slim });
}

// The shape every stored projection must have (src/events.js
// emptyRoomState + compact): a state object whose room is this room, with
// the core collections present. Anything else — valid JSON, wrong shape —
// is corruption a reader must refuse, not serve as a hollow room (#4127).
// O(1) field checks only: this runs on the hot read path. Returns the full
// set of short problem tokens, in the fixed order the checks run (empty
// when the shape is sound). Most callers need only the first problem; the
// full set matters where a decision turns on a problem being the ONLY one
// (the deferred-open deferral in server/store.mjs defers solely for the
// lone legacy channels_missing shape — a compound is corruption the
// integrity job cannot fully repair, so it must not ride the deferral).
export function projectionShapeProblems(state, roomId) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return ["not_an_object"];
  const problems = [];
  if (!state.room || typeof state.room !== "object" || Array.isArray(state.room)) problems.push("room_missing");
  else if (state.room.id !== roomId) problems.push("room_id_mismatch");
  if (!state.members || typeof state.members !== "object" || Array.isArray(state.members)) problems.push("members_missing");
  if (!state.channels || typeof state.channels !== "object" || Array.isArray(state.channels)) problems.push("channels_missing");
  if (!Array.isArray(state.messages)) problems.push("messages_missing");
  if (!state.workItems || typeof state.workItems !== "object" || Array.isArray(state.workItems)) problems.push("work_items_missing");
  return problems;
}
// The first shape problem, or null when the shape is sound.
export function projectionShapeProblem(state, roomId) {
  return projectionShapeProblems(state, roomId)[0] ?? null;
}
// Put bodies back into a state parsed from rooms.projection. Mutates and
// returns the state. `missing` lists messages whose body row is gone, which
// only an out-of-band write could cause; the caller rebuilds from the log.
//
// WRITE-PATH-WINS win 3: hydration used to re-hash every restored body
// against its bodyRef on every load — a full sha256 pass over the room's
// text per read, to catch a body row whose bytes were changed out of
// band. The row is content-addressed (its sha is the primary key, computed
// from the body at insert time and never updated), so the hot read path
// now trusts the key, as it already trusts every other stored byte it
// parses. Callers whose job is verification (the messages-parity /
// integrity path) pass verifyBodyHashes to keep the per-body check, and
// a row whose bytes no longer hash to its key is reported missing there,
// which routes the caller to the same rebuild-from-log recovery.
export function hydrateProjection(db, roomId, state, { verifyBodyHashes = false, workEntities = true } = {}) {
  if (workEntities) state = hydrateWorkItems(db, roomId, state);
  if (state?.messages?.some(isMessageEntityRef)) state.messages = hydrateMessageEntities(db,roomId,state.messages);
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const refs = messages.some(message => message && typeof message.bodyRef === "string");
  if (!refs && !messages.some(hasMarker)) return { state, missing: [] };
  if (refs) markedRooms(db).add(roomId);
  const bodies = refs ? new Map(prepared(db).read.all(roomId).map(row => [row.sha, row.body])) : new Map();
  const missing = [];
  messages.forEach((message, index) => {
    if (!message) return;
    if (hasMarker(message)) message = messages[index] = restoreEnvelope(message);
    if (typeof message.bodyRef !== "string") return;
    const body = bodies.get(message.bodyRef);
    if (typeof body !== "string" || (verifyBodyHashes && shaOf(body) !== message.bodyRef)) { missing.push(message.id); return; }
    messages[index] = renameKey(message, "bodyRef", "body", body);
  });
  return { state, missing };
}

// Bytes the stored row saves, for usage and tests.
export function atRestBodyBytes(db, roomId) {
  return db.prepare("SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS n FROM projection_bodies WHERE room_id=?").get(roomId).n;
}

// One message record read straight out of rooms.projection with SQLite JSON
// functions (conversation-sync's unindexed path). Same result as hydration.
// A missing row falls back to `recover(messageId)` (the store's hydrated
// room, which replays the event log), the same path store.room() uses.
export function hydrateRecordText(db, roomId, text, recover = null) {
  if (typeof text !== "string" || !text.includes('"bodyRef"') && !text.includes(`"${NULL_ENVELOPE_KEY}"`)) return text;
  let record = JSON.parse(text);
  if (hasMarker(record)) record = restoreEnvelope(record);
  if (typeof record?.bodyRef !== "string") return JSON.stringify(record);
  const row = db.prepare("SELECT body FROM projection_bodies WHERE room_id=? AND sha=?").get(roomId, record.bodyRef);
  let body = typeof row?.body === "string" && shaOf(row.body) === record.bodyRef ? row.body : null;
  if (body === null && recover) body = recover(record.id);
  if (typeof body !== "string") throw new Error("projection_corrupt: stored message body missing");
  return JSON.stringify(renameKey(record, "bodyRef", "body", body));
}

// Size breakdown of one stored room row, for the next capacity read. Bytes are
// UTF-8 bytes of the stored JSON (so after slimming), per top-level key and per
// message key, with how many messages carry each key.
export function projectionBreakdown(db, roomId) {
  const row = db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  if (!row) return null;
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const state = JSON.parse(row.projection);
  const topLevel = Object.entries(state).map(([key, value]) => ({ key, bytes: bytes(value) })).sort((a, b) => b.bytes - a.bytes);
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const perKey = new Map();
  for (const message of messages) for (const [key, value] of Object.entries(message ?? {})) {
    const entry = perKey.get(key) ?? { key, messages: 0, bytes: 0 };
    entry.messages += 1; entry.bytes += Buffer.byteLength(key) + 4 + bytes(value);
    perKey.set(key, entry);
  }
  return { totalBytes: Buffer.byteLength(row.projection), topLevel, messageCount: messages.length,
    averageMessageBytes: messages.length ? Math.round(bytes(messages) / messages.length) : 0,
    messageKeys: [...perKey.values()].sort((a, b) => b.bytes - a.bytes) };
}
