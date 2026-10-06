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
