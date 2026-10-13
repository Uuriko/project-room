// Phase 1a: message bodies at rest outside the room projection row.
//
// The reducer, the cache and every reader keep full message bodies in
// memory. Only the stored row changes: a message body at or above
// BODY_AT_REST_MIN_CHARS is replaced by `bodyRef` (its sha256) and the text
// is kept once in projection_bodies, keyed by content. Rows are immutable,
// so a write that is later rolled back or skipped can never change what an
// existing bodyRef means. A trigger on rooms deletes every body the stored
// projection no longer references, in the same statement, so deleted,
// redacted and purged text does not outlive the projection that held it.
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
CREATE TRIGGER IF NOT EXISTS projection_bodies_release AFTER UPDATE OF projection ON rooms
WHEN EXISTS (SELECT 1 FROM projection_bodies WHERE room_id=NEW.id)
BEGIN
  DELETE FROM projection_bodies WHERE room_id=NEW.id AND sha NOT IN (
    SELECT json_extract(m.value, '$.bodyRef') FROM json_each(NEW.projection, '$.messages') AS m
    WHERE json_type(m.value, '$.bodyRef') = 'text');
END;
CREATE TRIGGER IF NOT EXISTS projection_bodies_room_gone AFTER DELETE ON rooms
BEGIN
  DELETE FROM projection_bodies WHERE room_id=OLD.id;
END;`;

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
      read: db.prepare("SELECT sha, body FROM projection_bodies WHERE room_id=?")
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

// The only way a room projection is turned into the text stored in
// rooms.projection. With enabled=false the output is JSON.stringify(state),
// byte for byte, apart from rehydrating any bodyRef a raw-read state carries.
export function storedProjection(db, roomId, state, { enabled = false } = {}) {
  const messages = Array.isArray(state?.messages) ? state.messages : null;
  if (!messages) return JSON.stringify(state);
  const carriesRefs = messages.some(message => message && typeof message.bodyRef === "string" || hasMarker(message));
  if (!enabled && !carriesRefs) return JSON.stringify(state);
  if (!enabled) return JSON.stringify(hydrateProjection(db, roomId, structuredClone(state)).state);
  if (!messages.some(message => slimmable(message) || nullEnvelope(message))) return JSON.stringify(state);
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
  return JSON.stringify({ ...state, messages: slim });
}

// Put bodies back into a state parsed from rooms.projection. Mutates and
// returns the state. `missing` lists messages whose body row is gone, which
// only an out-of-band write could cause; the caller rebuilds from the log.
export function hydrateProjection(db, roomId, state) {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const refs = messages.some(message => message && typeof message.bodyRef === "string");
  if (!refs && !messages.some(hasMarker)) return { state, missing: [] };
  const bodies = refs ? new Map(prepared(db).read.all(roomId).map(row => [row.sha, row.body])) : new Map();
  const missing = [];
  messages.forEach((message, index) => {
    if (!message) return;
    if (hasMarker(message)) message = messages[index] = restoreEnvelope(message);
    if (typeof message.bodyRef !== "string") return;
    const body = bodies.get(message.bodyRef);
    if (typeof body !== "string" || shaOf(body) !== message.bodyRef) { missing.push(message.id); return; }
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
