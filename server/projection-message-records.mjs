// Message records live beside the room row. The reducer and every reader
// keep full messages in memory. The stored projection keeps one small ref
// per message (`{_m:1}`) and the record text lives in
// projection_message_records. A busy room then rewrites a short projection
// plus the one record that changed, instead of the whole message history.
//
// The marker is `_m`, not `_entity`. `_entity` is the certified messages
// table (#4738). Hydration of that marker reads a different table.
// This mode stays off unless the store is opened with sideTableMessages.
// Hydration stays on, so a row written by a newer process still reads.
// messageEntityProjection, when that window is on, owns the message list
// and this slimming steps aside.

export const PROJECTION_MESSAGE_RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_message_records (
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY(room_id, message_id)
);
CREATE TRIGGER IF NOT EXISTS projection_message_records_room_gone AFTER DELETE ON rooms
BEGIN
  DELETE FROM projection_message_records WHERE room_id=OLD.id;
END;`;

const modes = new WeakMap();
const memos = new WeakMap();
const statements = new WeakMap();
// Unchanged messages keep their object identity across posts (the reducer
// clones only the message an edit addresses). The text of that object does
// not change, so a later write skips both the stringify and the upsert.
const objectText = new WeakMap();

export function configureSideTableMessages(db, enabled) {
  modes.set(db, enabled === true);
}

export function sideTableMessagesEnabled(db) {
  return modes.get(db) === true;
}

export function clearSideTableMemo(db) {
  memos.delete(db);
}

export function isSideMessageRef(message) {
  return Boolean(message) && typeof message === "object" && !Array.isArray(message)
    && message._m === 1 && typeof message.id === "string";
}

function roomMemo(db, roomId) {
  let rooms = memos.get(db);
  if (!rooms) { rooms = new Map(); memos.set(db, rooms); }
  let memo = rooms.get(roomId);
  if (!memo) { memo = { texts: new Map(), loaded: false }; rooms.set(roomId, memo); }
  return memo;
}

function sql(db) {
  let hit = statements.get(db);
  if (!hit) {
    hit = {
      read: db.prepare("SELECT message_id, record FROM projection_message_records WHERE room_id=?"),
      upsert: db.prepare(`INSERT INTO projection_message_records(room_id, message_id, record) VALUES(?,?,?)
        ON CONFLICT(room_id, message_id) DO UPDATE SET record=excluded.record`),
      remove: db.prepare("DELETE FROM projection_message_records WHERE room_id=? AND message_id=?"),
      removeRoom: db.prepare("DELETE FROM projection_message_records WHERE room_id=?")
    };
    statements.set(db, hit);
  }
  return hit;
}

export function hydrateSideMessages(db, roomId, messages) {
  const rows = new Map(sql(db).read.all(roomId).map(row => [row.message_id, row.record]));
  return messages.map(message => {
    if (!isSideMessageRef(message)) return message;
    const record = rows.get(message.id);
    if (typeof record !== "string") throw new Error("projection_corrupt: missing message record");
    let parsed;
    try { parsed = JSON.parse(record); }
    catch { throw new Error("projection_corrupt: missing message record"); }
    if (!parsed || parsed.id !== message.id) throw new Error("projection_corrupt: missing message record");
    return parsed;
  });
}

// Replace full messages with refs, writing a record only when its text
// changed. `enabled: false` puts the text back in the array and drops the
// rows, which a rollback to an older build needs.
export function referenceProjectionMessages(db, roomId, messages, { enabled } = {}) {
  const on = enabled === false ? false : enabled === true ? true : sideTableMessagesEnabled(db);
  if (!Array.isArray(messages)) return messages;
  if (!on) {
    // A rollback asks for inline text while the store flag is still on.
    // The caller passes the hydrated messages, so the refs are already gone
    // and the rows still have to be dropped.
    const hadRefs = messages.some(isSideMessageRef);
    const full = hadRefs ? hydrateSideMessages(db, roomId, messages) : messages;
    if (hadRefs || (enabled === false && sideTableMessagesEnabled(db))) {
      sql(db).removeRoom.run(roomId);
      memos.get(db)?.delete(roomId);
    }
    return full;
  }
  const memo = roomMemo(db, roomId);
  const dbSql = sql(db);
  if (!memo.loaded) {
    for (const row of dbSql.read.all(roomId)) memo.texts.set(row.message_id, row.record);
    memo.loaded = true;
  }
  const seen = new Set();
  const refs = messages.map(message => {
    if (!message || typeof message !== "object" || typeof message.id !== "string") return message;
    if (isSideMessageRef(message) && Object.keys(message).length === 2) {
      seen.add(message.id);
      return { id: message.id, _m: 1 };
    }
    let text = objectText.get(message);
    if (text === undefined) {
      text = JSON.stringify(message);
      objectText.set(message, text);
    }
    if (memo.texts.get(message.id) !== text) {
      dbSql.upsert.run(roomId, message.id, text);
      memo.texts.set(message.id, text);
    }
    seen.add(message.id);
    return { id: message.id, _m: 1 };
  });
  const gone = [];
  for (const id of memo.texts.keys()) if (!seen.has(id)) gone.push(id);
  for (const id of gone) {
    dbSql.remove.run(roomId, id);
    memo.texts.delete(id);
  }
  return refs;
}
