// Move settled messages out of rooms.projection and into the paged messages
// table. A certified room uses the existing archive. A room whose messages
// backfill never reached the head (prod's parked room) copies the serving
// projection into the table in bounded chunks, then archives the rows that
// match. Older messages stay readable through paging and search. The stored
// shape is the archive marker this build already hydrates.

import { appendOperatorAction } from "./operator-actions.mjs";
import { affectedMessageIds, archiveRoomMessages, storedBody, writeServingMessages } from "./messages-store.mjs";

export const HOT_MESSAGE_WINDOW = 512;
export const COMPACT_MESSAGES_PER_CALL = 8000;
export const COMPACT_REASON = "settled messages moved out of the hot projection";

// Production entry points only. RoomStore's own default stays unbounded so
// existing stores and tests keep their certification behavior.
export function productionProjectionOptions() {
  return {
    messageProjectionWindow: HOT_MESSAGE_WINDOW,
    messageEntityProjection: true
  };
}

function projectionBytes(db, roomId) {
  return db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?").get(roomId)?.bytes ?? 0;
}

function postingSequences(db, roomId, wanted) {
  const found = new Map();
  if (!wanted.size) return found;
  const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence");
  for (const row of rows.iterate(roomId, "message.posted")) {
    let body;
    try { body = JSON.parse(row.body); } catch { continue; }
    for (const id of affectedMessageIds(body)) {
      if (wanted.has(id) && !found.has(id)) found.set(id, row.sequence);
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

// Insert or align messages-table rows from the serving projection. One call
// writes at most `limit` messages, oldest first. A row whose body already
// differs is left untouched.
export function prepareSettledRows(store, roomId, { limit = COMPACT_MESSAGES_PER_CALL } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return store.transaction(() => {
    const db = store.db;
    const state = store.room(roomId).state;
    const messages = state.messages ?? [];
    const ids = [];
    for (const message of messages) if (typeof message?.id === "string") ids.push(message.id);
    const existing = new Map();
    const lookup = db.prepare("SELECT message_id, body FROM messages WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))");
    for (let start = 0; start < ids.length; start += 256) {
      for (const row of lookup.all(roomId, JSON.stringify(ids.slice(start, start + 256)))) existing.set(row.message_id, row.body);
    }
    const needed = [];
    let skippedMismatch = 0;
    for (const message of messages) {
      if (typeof message?.id !== "string") continue;
      if (!existing.has(message.id)) { needed.push(message); continue; }
      if (existing.get(message.id) === storedBody(message)) needed.push(message);
      else skippedMismatch += 1;
    }
    const batch = needed.slice(0, limit);
    const wanted = new Set(batch.map(message => message.id));
    const sequences = postingSequences(db, roomId, wanted);
    const sequenceById = new Map();
    let missingSequence = 0;
    for (const message of batch) {
      const sequence = sequences.get(message.id);
      if (!Number.isInteger(sequence)) { missingSequence += 1; continue; }
      sequenceById.set(message.id, sequence);
    }
    return {
      prepared: writeServingMessages(db, { roomId, state, sequenceById }),
      skippedMismatch,
      missingSequence,
      remaining: Math.max(0, needed.length - batch.length)
    };
  });
}

function certifiedAtHead(db, roomId, sequence) {
  const cursor = db.prepare("SELECT applied_seq, parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
  return Boolean(cursor && cursor.applied_seq === sequence && cursor.parity_at_seq === sequence);
}

// One bounded pass. Returns counts only. A certified room sheds every settled
// message in this pass. An uncertified room sheds the chunk whose rows were
// just aligned; call again until archived is 0.
export function compactRoomProjection(store, roomId, { keepNewest = HOT_MESSAGE_WINDOW, dryRun = false } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not compact projections");
  if (!Number.isInteger(keepNewest) || keepNewest < 1) throw new Error("keepNewest must be a positive integer");
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
  if (!head) return { ok: false, reason: "room_not_found" };
  const before = projectionBytes(store.db, roomId);
  const certified = certifiedAtHead(store.db, roomId, head.sequence);
  const prepared = !certified && !dryRun ? prepareSettledRows(store, roomId) : null;
  const archived = archiveRoomMessages(store, roomId, {
    keepNewest, dryRun, settledProjection: !certified, keepMismatches: !certified
  });
  const after = projectionBytes(store.db, roomId);
  const result = {
    ok: archived.ok === true,
    ...(archived.ok ? {} : { reason: archived.reason }),
    dryRun,
    certified,
    archived: archived.archived ?? 0,
    retained: archived.retained ?? 0,
    freedBytes: Math.max(0, before - after),
    throughSeq: archived.throughSeq ?? 0,
    mismatches: archived.mismatches ?? 0,
    prepared: prepared?.prepared ?? 0,
    remaining: prepared?.remaining ?? 0,
    projectionBytes: { before, after }
  };
  if (!dryRun) {
    appendOperatorAction(store, {
      action: "projection_compact",
      targetKind: "room",
      targetId: roomId,
      reason: COMPACT_REASON,
      counts: {
        keepNewest,
        archived: result.archived,
        retained: result.retained,
        freedBytes: result.freedBytes,
        throughSeq: result.throughSeq,
        mismatches: result.mismatches,
        prepared: result.prepared,
        before,
        after
      },
      result: result.ok ? "ok" : "refused"
    });
  }
  return result;
}
