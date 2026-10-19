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
// This upgrade rewrites exactly those two fields to what the current reducer
// builds, in rooms.projection and in projection_checkpoints (a checkpoint is
// a replay's starting state, so a legacy checkpoint would re-create the old
// shape). It is idempotent and detected by SQL, so it runs at the shape-repair
// hook and before every parity step. Each room and target it changes gets one
// row in projection_shape_upgrades (counts only, no message text), and the
// room's parity certification is cleared so the next sweep re-certifies it.

export const LEGACY_MESSAGE_SHAPE_VERSION = 1;

export const PROJECTION_SHAPE_UPGRADES_SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_shape_upgrades (
  room_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('projection','checkpoint')),
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
  WHERE json_type(message.value, '$.reactions') IS NOT NULL
    OR (json_extract(message.value, '$.kind') = 'receipt_card'
      AND json_type(message.value, '$.receiptId') IS NULL)`;

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
  if (!roomIds.length && !checkpointIds.length) return { rooms: 0, reactionsRemoved: 0, receiptIdsAdded: 0 };
  const work = () => {
    db.exec(PROJECTION_SHAPE_UPGRADES_SCHEMA);
    const at = new Date(store.now()).toISOString();
    const record = db.prepare(`INSERT INTO projection_shape_upgrades
      (room_id, version, target, reactions_removed, receipt_ids_added, runs, first_at, last_at) VALUES (?,?,?,?,?,1,?,?)
      ON CONFLICT(room_id, version, target) DO UPDATE SET
        reactions_removed = reactions_removed + excluded.reactions_removed,
        receipt_ids_added = receipt_ids_added + excluded.receipt_ids_added,
        runs = runs + 1, last_at = excluded.last_at`);
    const hasCursor = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_backfill_cursor'").get());
    const totals = { rooms: 0, reactionsRemoved: 0, receiptIdsAdded: 0 };
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
    if (hasCursor) for (const roomId of touched) db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?").run(roomId);
    totals.rooms = touched.size;
    return totals;
  };
  return db.isTransaction ? work() : store.transaction(work);
}
