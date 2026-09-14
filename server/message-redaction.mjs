// Issue #6 D6: redaction that survives replay, export, import and restore.
//
// Deletion (message.deleted) is a visibility rule: the projection keeps a
// tombstone while the event log, exports and backups keep the text. Redaction
// is the one deliberate exception to append-only event bodies. The owner or
// the author appends a `message.redacted` event and, in the same transaction,
// the store rewrites the target's `message.posted` and `message.edited` events:
// `data.body` is removed and `data.redacted = { bodySha256, redactionId }`
// names the SHA-256 of the removed text and the redaction event. Event ids,
// sequences and the message's place in the log stay, so replaying the
// rewritten log (projection rebuild, export/import, a restored backup)
// reproduces the redaction and never the text. The projection keeps who,
// when and the hash of the last body, which is what the recovery audit and
// native text results compare from then on.
//
// Schema v29 adds `message_redactions`, one row per redacted message, so a
// restore or an operator can list the obligations without decoding the log;
// verifyMessageRedactions runs on every open (writable and read-only) and
// refuses a store where redacted text survives in the events, the projection
// or the projection checkpoint. Retention policy and preservation holds are
// documented as follow-ups in docs/EXPORT-RETENTION-DELETION.md.
import { createHash } from "node:crypto";
import { EVENT_TYPES as T, applyEvent, event, redactedBody, validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

export const MESSAGE_REDACTION_SCHEMA_VERSION = 29;
export const messageRedactionSchema = `
  CREATE TABLE IF NOT EXISTS message_redactions (
    room_id TEXT NOT NULL REFERENCES rooms(id), message_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL,
    body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64), redacted_at TEXT NOT NULL, redacted_by TEXT NOT NULL,
    PRIMARY KEY(room_id, message_id), FOREIGN KEY(room_id, sequence) REFERENCES events(room_id, sequence))`;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
export const bodySha256 = body => sha256(body);
const hasTable = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_redactions'").get());
// The message an event carries text for: a post is keyed by its messageId or its own id.
export const messageIdOf = e => e.type === T.MESSAGE_POSTED ? (e.data.messageId || e.id) : [T.MESSAGE_EDITED, T.MESSAGE_DELETED, T.MESSAGE_REDACTED].includes(e.type) ? e.data.messageId : null;
const carriesText = e => [T.MESSAGE_POSTED, T.MESSAGE_EDITED].includes(e.type);
const BODY_EVENTS_SQL = "SELECT sequence,id,body FROM events WHERE room_id=? AND ((json_extract(body,'$.type')='message.posted' AND coalesce(json_extract(body,'$.data.messageId'),id)=?) OR (json_extract(body,'$.type')='message.edited' AND json_extract(body,'$.data.messageId')=?)) ORDER BY sequence";
const INSERT_ROW = "INSERT INTO message_redactions(room_id,message_id,event_id,sequence,body_sha256,redacted_at,redacted_by) VALUES(?,?,?,?,?,?,?)";

// Idempotent: a re-run on a migrated store changes nothing. No message.redacted
// event exists before v29, so the backfill matches no row; it is kept so the
// table and the log agree by construction on every path through here.
export function migrateMessageRedactionsV29(store) {
  store.transaction(() => {
    store.db.exec(messageRedactionSchema);
    store.db.prepare(`INSERT OR IGNORE INTO message_redactions(room_id,message_id,event_id,sequence,body_sha256,redacted_at,redacted_by)
      SELECT room_id, json_extract(body,'$.data.messageId'), id, sequence, json_extract(body,'$.data.bodySha256'), json_extract(body,'$.at'), json_extract(body,'$.actorId')
      FROM events WHERE json_extract(body,'$.type')='message.redacted'`).run();
    store.storagePlatform.setVersion(store.db, MESSAGE_REDACTION_SCHEMA_VERSION);
  });
}

// Startup audit for both the writable and the read-only open. Read-only never
// migrates or repairs. Every redaction event has its row and every row its
// event; no redacted message keeps text in the log, the projection or the
// retained checkpoint.
const INVARIANTS = [
  "SELECT 1 FROM events e WHERE json_extract(e.body,'$.type')='message.redacted' AND NOT EXISTS (SELECT 1 FROM message_redactions r WHERE r.room_id=e.room_id AND r.event_id=e.id AND r.sequence=e.sequence AND r.message_id=json_extract(e.body,'$.data.messageId') AND r.body_sha256=json_extract(e.body,'$.data.bodySha256')) LIMIT 1",
  "SELECT 1 FROM message_redactions r WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.room_id=r.room_id AND e.sequence=r.sequence AND e.id=r.event_id AND json_extract(e.body,'$.type')='message.redacted') LIMIT 1",
  "SELECT 1 FROM message_redactions r JOIN events e ON e.room_id=r.room_id WHERE json_type(e.body,'$.data.body') IS NOT NULL AND ((json_extract(e.body,'$.type')='message.posted' AND coalesce(json_extract(e.body,'$.data.messageId'),e.id)=r.message_id) OR (json_extract(e.body,'$.type')='message.edited' AND json_extract(e.body,'$.data.messageId')=r.message_id)) LIMIT 1",
  "SELECT 1 FROM message_redactions r JOIN rooms ro ON ro.id=r.room_id, json_each(ro.projection,'$.messages') m WHERE json_extract(m.value,'$.id')=r.message_id AND (json_type(m.value,'$.body') IS NOT 'null' OR json_extract(m.value,'$.redactedAt') IS NULL OR json_extract(m.value,'$.bodySha256') IS NOT r.body_sha256 OR json_array_length(m.value,'$.editHistory')>0) LIMIT 1",
  "SELECT 1 FROM message_redactions r JOIN projection_checkpoints c ON c.room_id=r.room_id, json_each(c.projection,'$.messages') m WHERE json_extract(m.value,'$.id')=r.message_id AND (json_type(m.value,'$.body') IS NOT 'null' OR json_array_length(m.value,'$.editHistory')>0) LIMIT 1"
];
export function verifyMessageRedactions(store) {
  if (!hasTable(store.db)) throw new Error("Message redaction schema requires operator reconciliation");
  for (const sql of INVARIANTS) if (store.db.prepare(sql).get()) throw new Error("Message redaction requires operator reconciliation");
}

// A rewritten event: the text is replaced by its hash and the redaction event's id.
export function rewriteRedacted(e, redactionId) {
  const { body, ...rest } = e.data;
  return { ...e, data: { ...rest, redacted: { bodySha256: sha256(body), redactionId } } };
}

// Pure check over a whole history (import, bootstrap): every text-bearing event
// of a redacted message carries the record of that message's redaction event,
// and no record names a redaction that is not in the history. Returns the rows
// the message_redactions table needs for this history.
export function historyRedactions(events) {
  const redactions = new Map();
  events.forEach((e, index) => {
    if (e.type !== T.MESSAGE_REDACTED) return;
    if (redactions.has(e.data.messageId)) throw new Error("A message is redacted twice");
    redactions.set(e.data.messageId, { messageId: e.data.messageId, eventId: e.id, sequence: index + 1, bodySha256: e.data.bodySha256, at: e.at, by: e.actorId });
  });
  for (const e of events) {
    if (!carriesText(e)) continue;
    const record = redactedBody(e.data), redaction = redactions.get(messageIdOf(e));
    if (record && record.redactionId !== redaction?.eventId) throw new Error("A redaction record names no redaction event for its message");
    if (!record && redaction) throw new Error("A redacted message still carries text");
  }
  return [...redactions.values()];
}
export function insertRedactions(store, roomId, rows) {
  const insert = store.db.prepare(INSERT_ROW);
  for (const row of rows) insert.run(roomId, row.messageId, row.eventId, row.sequence, row.bodySha256, row.at, row.by);
}

// The command path, reached from store.command() once the caller is
// authenticated, the command id is new and the room is not archived. Errors
// follow the ordinary command surface (422 command_rejected from the reducer).
// Redaction is cleanup: it is accepted at the room's event capacity, like
// ending a membership. A second redaction of the same message appends nothing
// and answers the first one with duplicate: true.
export function redactMessage(store, roomId, auth, command, fingerprint, room) {
  const { messageId } = command.data;
  if (!validId(messageId)) fail(422, "invalid_command", "Invalid field: messageId");
  const message = room.state.messages.find(m => m.id === messageId);
  if (!message) fail(422, "command_rejected", "Message not found");
  if (message.redactedAt) {
    const row = store.db.prepare("SELECT r.sequence,e.body FROM message_redactions r JOIN events e ON e.room_id=r.room_id AND e.sequence=r.sequence WHERE r.room_id=? AND r.message_id=?").get(roomId, messageId);
    if (!row) throw new Error("Message redaction requires operator reconciliation");
    return { sequence: row.sequence, event: JSON.parse(row.body), duplicate: true };
  }
  const rows = store.db.prepare(BODY_EVENTS_SQL).all(roomId, messageId, messageId).map(row => ({ ...row, event: JSON.parse(row.body) }))
    .filter(row => typeof row.event.data.body === "string");
  if (!rows.length) throw new Error("Message redaction requires operator reconciliation");
  const at = new Date(store.now()).toISOString();
  const incoming = event({ type: T.MESSAGE_REDACTED, roomId, actorId: auth.member.id, at, idempotencyKey: sha256(`${auth.member.id}:${command.id}`),
    causationId: command.causationId, data: { messageId, bodySha256: sha256(rows.at(-1).event.data.body) } });
  try { applyEvent(room.state, incoming); }
  catch (error) { fail(422, "command_rejected", error.message); }
  const sequence = room.sequence + 1;
  const update = store.db.prepare("UPDATE events SET body=? WHERE room_id=? AND sequence=?");
  for (const row of rows) update.run(JSON.stringify(rewriteRedacted(row.event, incoming.id)), roomId, row.sequence);
  // The retained checkpoint (legacy rooms only) is a replay accelerator that may
  // hold the text; keep it usable and body-less rather than dropping it.
  const checkpoint = store.db.prepare("SELECT sequence,projection FROM projection_checkpoints WHERE room_id=?").get(roomId);
  if (checkpoint) {
    const state = JSON.parse(checkpoint.projection), held = state.messages?.find(m => m.id === messageId);
    if (held) { held.body = null; held.editHistory = []; store.db.prepare("UPDATE projection_checkpoints SET projection=? WHERE room_id=?").run(JSON.stringify(state), roomId); }
  }
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  store.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, command.id, fingerprint, sequence);
  store.db.prepare(INSERT_ROW).run(roomId, messageId, incoming.id, sequence, incoming.data.bodySha256, at, auth.member.id);
  // The stored projection is the replay of the rewritten log, the same walk the
  // recovery audit and every restore perform, so the two agree by construction.
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(sequence, roomId);
  const { state } = store.rebuildProjection(roomId);
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(state), roomId);
  return { sequence, event: incoming, duplicate: false };
}
