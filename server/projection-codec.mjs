// Phase 1a (hard-h3-slim-projection): "slim at rest, full in memory".
// A message body leaves the stored rooms.projection row only when the
// messages table (MSG-1) already holds a byte-equal body for the same
// (room_id, message_id). Everything else stays inline, so rooms the MSG-2
// backfill has not reached, and edits not yet in the table, are untouched.
// Decode refills at-rest bodies from the messages table. A body that cannot
// be found degrades only that message (bodyUnavailable: true) and reports it
// through onMissing, so the room stays readable (Instinct-3 3938 item 2).
// Gated by PROJECTION_BODIES_AT_REST=1; decode always accepts both shapes.

export const BODY_AT_REST = "bodyAtRest";

export function bodiesAtRestEnabled(env = process.env) {
  return env?.PROJECTION_BODIES_AT_REST === "1";
}

function tableBodies(db, roomId) {
  const rows = db.prepare("SELECT message_id, body FROM messages WHERE room_id=? AND body IS NOT NULL").all(roomId);
  const map = new Map();
  for (const row of rows) map.set(row.message_id, row.body);
  return map;
}

export function encodeProjection(db, roomId, state, { enabled = bodiesAtRestEnabled() } = {}) {
  const messages = state?.messages;
  if (!enabled || !Array.isArray(messages) || messages.length === 0) return JSON.stringify(state);
  const bodies = tableBodies(db, roomId);
  let slimmed = 0;
  const out = messages.map(message => {
    if (!message || typeof message.body !== "string" || message.body.length === 0) return message;
    if (bodies.get(message.id) !== message.body) return message;
    slimmed += 1;
    // body stays as a key (null) so decode restores the original key order.
    return { ...message, body: null, [BODY_AT_REST]: 1 };
  });
  return slimmed === 0 ? JSON.stringify(state) : JSON.stringify({ ...state, messages: out });
}

export function decodeProjection(db, roomId, text, { onMissing } = {}) {
  const state = JSON.parse(text);
  const messages = state?.messages;
  if (!Array.isArray(messages) || !messages.some(m => m && m[BODY_AT_REST] === 1)) return state;
  const bodies = tableBodies(db, roomId);
  const missing = [];
  state.messages = messages.map(message => {
    if (!message || message[BODY_AT_REST] !== 1) return message;
    const { [BODY_AT_REST]: _flag, ...rest } = message;
    const body = bodies.get(message.id);
    if (typeof body === "string") { rest.body = body; return rest; }
    missing.push(message.id);
    return { ...rest, bodyUnavailable: true };
  });
  if (missing.length && typeof onMissing === "function") onMissing({ roomId, messageIds: missing });
  return state;
}


// Every rooms.projection write goes through storedProjection (ratchet:
// tests/projection-writers.test.js). Flag off it returns exactly what the
// writer used to store: the same string, or JSON.stringify of the state.
export function storedProjection(db, roomId, value, { enabled = bodiesAtRestEnabled() } = {}) {
  if (!enabled) return typeof value === "string" ? value : JSON.stringify(value);
  const state = typeof value === "string" ? JSON.parse(value) : value;
  return encodeProjection(db, roomId, state, { enabled: true });
}

let missingAlarm = null;
export function setMissingBodyAlarm(fn) { missingAlarm = typeof fn === "function" ? fn : null; }
function defaultMissing(event) {
  if (missingAlarm) return missingAlarm(event);
  console.error(`[projection-codec] body_unavailable room=${event.roomId} count=${event.messageIds.length}`);
}

// Every reader of rooms.projection that may see messages decodes through
// here. A legacy inline row is parsed and returned as-is.
export function readProjection(db, roomId, text, { onMissing = defaultMissing } = {}) {
  return decodeProjection(db, roomId, text, { onMissing });
}

// Before anything deletes table bodies wholesale (backfill reset, a replaced
// log), put the bodies back inline so the row never points at a gone body
// (Instinct-3 3938 item 4: a lagging table never loses text).
export function rehydrateRoomBodies(db, roomId) {
  const row = db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  if (!row?.projection || !row.projection.includes(`"${BODY_AT_REST}":1`)) return false;
  const state = decodeProjection(db, roomId, row.projection, { onMissing: defaultMissing });
  db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), roomId);
  return true;
}


// The way back (Instinct-3 3938 item 6): before rolling back to code that
// predates Phase 1a, inline every slim row. Returns how many rows changed.
export function rehydrateAllRooms(db) {
  let changed = 0;
  for (const { id } of db.prepare(`SELECT id FROM rooms WHERE instr(projection, '"${BODY_AT_REST}":1') > 0`).all()) {
    if (rehydrateRoomBodies(db, id)) changed += 1;
  }
  return changed;
}
