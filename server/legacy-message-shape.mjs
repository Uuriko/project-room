// Projection shape upgrade v1: legacy message records (research r57/r58).
//
// Two reducer changes altered how old events project, and nothing rewrote the
// stored projections that were built before them:
//   - d7578160f (2026-10-11) derives `receiptId` (data.receiptId, else
//     rc_<claimId>) on every receipt_card message. Cards projected earlier
//     have no receiptId.
//   - #3831 (2026-10-16) removed reactions; replay skips message.reaction_set.
//     Messages reacted to earlier still carry `reactions`.
// A replay of the log (the messages backfill, the recovery audit) builds the
// current shapes, so messages parity fails on the first such record. On prod
// muse-room that is 138 records (127 cards, 11 reacted messages; r57).
//
// The integrity job's last success was 2026-10-11T19:30:55Z. On 2026-10-25
// it had failed 287 ticks in a row, every one reported as messages_parity.
// The backfill publishes a room once, when it catches up, and does not
// publish it again. That catch-up wrote messages.record_json with the
// reducer of the day: receiptId derived, reactions still applied. The
// 2026-10-18 upgrade rewrote only rooms.projection (and checkpoints) to
// the current reducer, then its SQL stopped matching, so the indexed
// records stayed on the old shape. Parity compares the two and still fails.
//
// This upgrade rewrites exactly those two fields to what the current reducer
// builds, in rooms.projection, in projection_checkpoints (a checkpoint is a
// replay's starting state, so a legacy checkpoint would re-create the old
// shape), and in messages.record_json. The retired reactions_json column is
// cleared on a row whose record loses its reactions map, which is what the
// live writer stores now. It is idempotent and detected by SQL, so it runs
// at the shape-repair hook and before every parity step. Each room and
// target it changes gets one row in projection_shape_upgrades (counts only,
// no message text), and the room's parity certification is cleared so the
// next sweep re-certifies it. Any other difference between the record and
// the projection is left in place and still fails parity.

export const LEGACY_MESSAGE_SHAPE_VERSION = 1;

export const PROJECTION_SHAPE_UPGRADES_SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_shape_upgrades (
  room_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('projection','checkpoint','messages')),
  reactions_removed INTEGER NOT NULL,
  receipt_ids_added INTEGER NOT NULL,
  runs INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY(room_id, version, target)
);`;

const legacyRoomsSql = table => `
  SELECT DISTINCT ${table}.${table === "rooms" ? "id" : "room_id"} AS id
  FROM ${table}, json_each(${table}.projection, '$.messages') AS message
  WHERE json_valid(${table}.projection) AND (json_type(message.value, '$.reactions') IS NOT NULL
    OR (json_extract(message.value, '$.kind') = 'receipt_card'
      AND json_type(message.value, '$.receiptId') IS NULL))`;

// Rebuild with receiptId directly after claimId, the reducer's key order, so
// a stored record reads byte-for-byte like a freshly projected one.
function withReceiptId(message, receiptId) {
  const out = {};
  let placed = false;
  for (const [key, value] of Object.entries(message)) {
    out[key] = value;
    if (key === "claimId") { out.receiptId = receiptId; placed = true; }
  }
  if (!placed) out.receiptId = receiptId;
  return out;
}

// Pure: upgrade one state's messages in place. receiptIds maps a card's
// message id to the receiptId its posting event carried, when it carried one.
export function upgradeLegacyMessages(state, receiptIds = new Map()) {
  let reactionsRemoved = 0;
  let receiptIdsAdded = 0;
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (let index = 0; index < messages.length; index += 1) {
    let message = messages[index];
    if (!message || typeof message !== "object") continue;
    if (Object.hasOwn(message, "reactions")) {
      message = { ...message };
      delete message.reactions;
      reactionsRemoved += 1;
    }
    if (message.kind === "receipt_card" && (message.receiptId === undefined || message.receiptId === null)
      && typeof message.claimId === "string" && message.claimId) {
      message = withReceiptId(message, receiptIds.get(message.id) || `rc_${message.claimId}`);
      receiptIdsAdded += 1;
    }
    messages[index] = message;
  }
  return { reactionsRemoved, receiptIdsAdded };
}

// The audit table's target check gained 'messages' when indexed records
// joined the upgrade. CREATE TABLE IF NOT EXISTS does not widen a check
// that is already stored, so an existing table is rebuilt in place.
function ensureAuditTable(db) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projection_shape_upgrades'").get();
  if (!existing) {
    db.exec(PROJECTION_SHAPE_UPGRADES_SCHEMA);
    return;
  }
  if (existing.sql.includes("'messages'")) return;
  db.exec(`CREATE TABLE projection_shape_upgrades_next (
    room_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    target TEXT NOT NULL CHECK(target IN ('projection','checkpoint','messages')),
    reactions_removed INTEGER NOT NULL,
    receipt_ids_added INTEGER NOT NULL,
    runs INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    PRIMARY KEY(room_id, version, target)
  );
  INSERT INTO projection_shape_upgrades_next
    (room_id, version, target, reactions_removed, receipt_ids_added, runs, first_at, last_at)
    SELECT room_id, version, target, reactions_removed, receipt_ids_added, runs, first_at, last_at
    FROM projection_shape_upgrades;
  DROP TABLE projection_shape_upgrades;
  ALTER TABLE projection_shape_upgrades_next RENAME TO projection_shape_upgrades;`);
}

// Indexed records the projection upgrade does not see once rooms.projection
// is already current. Same two fields as legacyRoomsSql, plus an explicit
// JSON null receiptId, which the projection scan treats as absent too.
function legacyMessageRecords(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) return [];
  return db.prepare(`SELECT room_id AS roomId, message_id AS messageId, record_json AS recordJson
    FROM messages
    WHERE record_json IS NOT NULL AND json_valid(record_json) AND (
      json_type(record_json, '$.reactions') IS NOT NULL
      OR (json_extract(record_json, '$.kind') = 'receipt_card'
        AND (json_type(record_json, '$.receiptId') IS NULL OR json_type(record_json, '$.receiptId') = 'null'))
    )`).all();
}

function eventReceiptIds(db, roomId) {
  const ids = new Map();
  const rows = db.prepare(`SELECT json_extract(body, '$.data.messageId') AS messageId, json_extract(body, '$.id') AS eventId,
      json_extract(body, '$.data.receiptId') AS receiptId
    FROM events WHERE room_id=? AND json_extract(body, '$.type')='message.posted'
      AND json_extract(body, '$.data.kind')='receipt_card' AND json_type(body, '$.data.receiptId')='text'`).all(roomId);
  for (const row of rows) ids.set(row.messageId || row.eventId, row.receiptId);
  return ids;
}

// Runs inside the caller's transaction when there is one. `serialize` is the
// store's projection serializer (bodies at rest); `skipIds` are rooms another
// repair is about to rewrite in the same pass.
export function runLegacyMessageShapeUpgrade(store, { skipIds = new Set() } = {}) {
  const db = store.db;
  const hasCheckpoints = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_checkpoints'").get());
  const roomIds = db.prepare(legacyRoomsSql("rooms")).all().map(row => row.id).filter(id => !skipIds.has(id));
  const checkpointIds = hasCheckpoints ? db.prepare(legacyRoomsSql("projection_checkpoints")).all().map(row => row.id).filter(id => !skipIds.has(id)) : [];
  const recordsByRoom = new Map();
  for (const row of legacyMessageRecords(db)) {
    if (skipIds.has(row.roomId)) continue;
    const list = recordsByRoom.get(row.roomId) ?? [];
    list.push(row);
    recordsByRoom.set(row.roomId, list);
  }
  if (!roomIds.length && !checkpointIds.length && !recordsByRoom.size) return { rooms: 0, reactionsRemoved: 0, receiptIdsAdded: 0, records: 0 };
  const work = () => {
    ensureAuditTable(db);
    const at = new Date(store.now()).toISOString();
    const record = db.prepare(`INSERT INTO projection_shape_upgrades
      (room_id, version, target, reactions_removed, receipt_ids_added, runs, first_at, last_at) VALUES (?,?,?,?,?,1,?,?)
      ON CONFLICT(room_id, version, target) DO UPDATE SET
        reactions_removed = reactions_removed + excluded.reactions_removed,
        receipt_ids_added = receipt_ids_added + excluded.receipt_ids_added,
        runs = runs + 1, last_at = excluded.last_at`);
    const hasCursor = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_backfill_cursor'").get());
    const totals = { rooms: 0, reactionsRemoved: 0, receiptIdsAdded: 0, records: 0 };
    const touched = new Set();
    for (const roomId of roomIds) {
      const state = JSON.parse(db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection);
      const counts = upgradeLegacyMessages(state, eventReceiptIds(db, roomId));
      if (!counts.reactionsRemoved && !counts.receiptIdsAdded) continue;
      db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(store.storedProjection(roomId, state), roomId);
      record.run(roomId, LEGACY_MESSAGE_SHAPE_VERSION, "projection", counts.reactionsRemoved, counts.receiptIdsAdded, at, at);
      totals.reactionsRemoved += counts.reactionsRemoved;
      totals.receiptIdsAdded += counts.receiptIdsAdded;
      touched.add(roomId);
    }
    for (const roomId of checkpointIds) {
      const row = db.prepare("SELECT projection FROM projection_checkpoints WHERE room_id=?").get(roomId);
      const state = JSON.parse(row.projection);
      const counts = upgradeLegacyMessages(state, eventReceiptIds(db, roomId));
      if (!counts.reactionsRemoved && !counts.receiptIdsAdded) continue;
      // Checkpoints keep full bodies (replay applies edits to them).
      db.prepare("UPDATE projection_checkpoints SET projection=? WHERE room_id=?").run(JSON.stringify(state), roomId);
      record.run(roomId, LEGACY_MESSAGE_SHAPE_VERSION, "checkpoint", counts.reactionsRemoved, counts.receiptIdsAdded, at, at);
      touched.add(roomId);
    }
    // reactions_json is cleared only when this record actually lost its
    // reactions map. A card that only gains receiptId keeps the column.
    const updateRecord = db.prepare("UPDATE messages SET record_json=?, reactions_json=CASE WHEN ? = 1 THEN NULL ELSE reactions_json END WHERE room_id=? AND message_id=?");
    for (const [roomId, rows] of recordsByRoom) {
      const receiptIds = eventReceiptIds(db, roomId);
      let reactionsRemoved = 0;
      let receiptIdsAdded = 0;
      let records = 0;
      for (const row of rows) {
        let parsed;
        try { parsed = JSON.parse(row.recordJson); } catch { continue; }
        const state = { messages: [parsed] };
        const counts = upgradeLegacyMessages(state, receiptIds);
        if (!counts.reactionsRemoved && !counts.receiptIdsAdded) continue;
        updateRecord.run(JSON.stringify(state.messages[0]), counts.reactionsRemoved ? 1 : 0, roomId, row.messageId);
        reactionsRemoved += counts.reactionsRemoved;
        receiptIdsAdded += counts.receiptIdsAdded;
        records += 1;
      }
      if (!records) continue;
      record.run(roomId, LEGACY_MESSAGE_SHAPE_VERSION, "messages", reactionsRemoved, receiptIdsAdded, at, at);
      totals.reactionsRemoved += reactionsRemoved;
      totals.receiptIdsAdded += receiptIdsAdded;
      totals.records += records;
      touched.add(roomId);
    }
    if (hasCursor) for (const roomId of touched) db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?").run(roomId);
    totals.rooms = touched.size;
    return totals;
  };
  return db.isTransaction ? work() : store.transaction(work);
}
