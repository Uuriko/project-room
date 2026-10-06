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
// next write of each room store full bodies again; rehydrateAll() does that
// for every room at once, which an older build needs before a rollback.
import { createHash } from "node:crypto";

export const BODY_AT_REST_MIN_CHARS = 512;

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

// The only way a room projection is turned into the text stored in
// rooms.projection. With enabled=false the output is JSON.stringify(state),
// byte for byte, apart from rehydrating any bodyRef a raw-read state carries.
export function storedProjection(db, roomId, state, { enabled = false } = {}) {
  const messages = Array.isArray(state?.messages) ? state.messages : null;
  if (!messages) return JSON.stringify(state);
  const carriesRefs = messages.some(message => message && typeof message.bodyRef === "string");
  if (!enabled && !carriesRefs) return JSON.stringify(state);
  if (!enabled) return JSON.stringify(hydrateProjection(db, roomId, structuredClone(state)).state);
  if (!messages.some(slimmable)) return JSON.stringify(state);
  const { known, insert } = prepared(db);
  const present = new Set(known.all(roomId).map(row => row.sha));
  const memo = memoFor(db, roomId), seen = new Map();
  const slim = messages.map(message => {
    if (!slimmable(message)) return message;
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
  if (!messages.some(message => message && typeof message.bodyRef === "string")) return { state, missing: [] };
  const bodies = new Map(prepared(db).read.all(roomId).map(row => [row.sha, row.body]));
  const missing = [];
  messages.forEach((message, index) => {
    if (!message || typeof message.bodyRef !== "string") return;
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
export function hydrateRecordText(db, roomId, text) {
  if (typeof text !== "string" || !text.includes('"bodyRef"')) return text;
  const record = JSON.parse(text);
  if (typeof record?.bodyRef !== "string") return text;
  const row = db.prepare("SELECT body FROM projection_bodies WHERE room_id=? AND sha=?").get(roomId, record.bodyRef);
  if (typeof row?.body !== "string" || shaOf(row.body) !== record.bodyRef) throw new Error("projection_corrupt: stored message body missing");
  return JSON.stringify(renameKey(record, "bodyRef", "body", row.body));
}
