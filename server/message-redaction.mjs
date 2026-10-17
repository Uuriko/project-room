// PRIV-1: rewrite a message out of the log, the projection, and the messages
// table in one transaction. Read-time masking stays; this is the write that
// makes the old text unreadable in storage.

import { storedProjection } from "./projection-at-rest.mjs"; // Phase 1a
import { applyEvent, event, EVENT_TYPES, isRoomArchived } from "../src/events.js";
import { syncMessageRows } from "./messages-store.mjs";

const compact = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

function parseEvent(body) {
  try { return JSON.parse(body); }
  catch { return null; }
}

function postedMessageId(entry) {
  const data = entry?.data ?? {};
  return typeof data.messageId === "string" && data.messageId ? data.messageId : entry?.id;
}

function eventTargetsMessage(entry, messageId) {
  if (!entry || (entry.type !== EVENT_TYPES.MESSAGE_POSTED && entry.type !== EVENT_TYPES.MESSAGE_EDITED)) return false;
  if (entry.type === EVENT_TYPES.MESSAGE_POSTED) return postedMessageId(entry) === messageId;
  return entry.data?.messageId === messageId;
}

function receiptCites(state, messageId) {
  for (const work of Object.values(state?.workItems ?? {})) {
    for (const receipt of [...(work.receiptHistory ?? []), work.receipt]) {
      if (receipt?.nativeText?.messageId === messageId) return true;
    }
  }
  return false;
}

// Null body and attachments on earlier events for this message, then append
// message.redacted (and receipt.evidence_withdrawn when a receipt cites it).
// A channel-copy id shares its text with the source event, so only the source
// id rewrites the log; the copy is cleared on the projection by the reducer.
// Already-redacted messages are left as they are. Returns the compact state
// the rooms row now stores. `sequence` on the command that triggered this
// stays the delete event; the room sequence advances past the new events.
export function commitMessageRedaction(db, { roomId, state, actorId, at, messageId, bodiesAtRest = false }) {
  if (typeof roomId !== "string" || typeof messageId !== "string" || !messageId) {
    return { state, sequence: null, rewritten: 0 };
  }
  const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId);
  let postedBody = null;
  let alreadyRedacted = false;
  let alreadyWithdrawn = false;
  const parsed = [];
  for (const row of rows) {
    const entry = parseEvent(row.body);
    parsed.push({ sequence: row.sequence, entry });
    if (!entry) continue;
    if (entry.type === EVENT_TYPES.MESSAGE_REDACTED && entry.data?.messageId === messageId) alreadyRedacted = true;
    if (entry.type === EVENT_TYPES.RECEIPT_EVIDENCE_WITHDRAWN && entry.data?.messageId === messageId) alreadyWithdrawn = true;
    if (entry.type === EVENT_TYPES.MESSAGE_POSTED && postedMessageId(entry) === messageId
      && typeof entry.data?.body === "string" && postedBody === null) postedBody = entry.data.body;
  }
  const byteLength = typeof postedBody === "string" ? Buffer.byteLength(postedBody, "utf8") : null;
  // Every text this message ever carried in the log, read before the rewrite
  // below nulls it: the kept replay snapshot must contain none of them.
  const removedTexts = [];
  if (!messageId.endsWith(":channel")) {
    for (const row of parsed) {
      if (eventTargetsMessage(row.entry, messageId) && typeof row.entry.data?.body === "string" && row.entry.data.body) {
        removedTexts.push(row.entry.data.body);
      }
    }
  }
  const sourceId = messageId.endsWith(":channel") ? null : messageId;
  const update = db.prepare("UPDATE events SET body=? WHERE room_id=? AND sequence=?");
  let rewritten = 0;
  if (sourceId) {
    for (const row of parsed) {
      const entry = row.entry;
      if (!eventTargetsMessage(entry, sourceId)) continue;
      const hasAttachments = Object.hasOwn(entry.data, "attachments") && entry.data.attachments != null;
      if (entry.data.body == null && entry.data.redacted === true && !hasAttachments) continue;
      if (Object.hasOwn(entry.data, "body")) entry.data.body = null;
      if (hasAttachments) entry.data.attachments = null;
      entry.data.redacted = true;
      update.run(JSON.stringify(entry), roomId, row.sequence);
      rewritten += 1;
    }
  }

  let next = state;
  let sequence = rows.reduce((max, row) => Math.max(max, row.sequence), 0);
  if (!isRoomArchived(state)) {
    const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?)");
    const length = Number.isInteger(byteLength) && byteLength > 0 ? { byteLength } : {};
    if (receiptCites(state, messageId) && !alreadyWithdrawn) {
      const incoming = event({
        type: EVENT_TYPES.RECEIPT_EVIDENCE_WITHDRAWN,
        actorId, roomId, at,
        data: { messageId, evidence: "removed", ...length }
      });
      next = applyEvent(next, incoming);
      sequence += 1;
      insert.run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    }
    if (!alreadyRedacted) {
      const incoming = event({
        type: EVENT_TYPES.MESSAGE_REDACTED,
        actorId, roomId, at,
        data: { messageId, ...length }
      });
      next = applyEvent(next, incoming);
      sequence += 1;
      insert.run(roomId, sequence, incoming.id, JSON.stringify(incoming));
      syncMessageRows(db, { roomId, sequence, event: incoming, state: next });
    }
  }

  const ids = messageId.endsWith(":channel") ? [messageId] : [messageId, `${messageId}:channel`];
  try {
    db.prepare(`UPDATE messages SET body=NULL, deleted_at=COALESCE(deleted_at, ?) WHERE room_id=? AND message_id IN (${ids.map(() => "?").join(",")})`).run(at, roomId, ...ids);
    if (isRoomArchived(state)) {
      db.prepare(`UPDATE messages SET record_json=NULL WHERE room_id=? AND message_id IN (${ids.map(() => "?").join(",")})`).run(roomId, ...ids);
    }
    // A replay snapshot may retain old edit text and attachment metadata.
    // Redact the message inside it in the same deletion transaction, the way
    // the rewritten log now replays it. Discarding the snapshot instead made
    // the next backfill replay the room's whole log from sequence 0 through
    // today's reducer, and one old event written before a validation
    // tightening then parked the room for good (integrity red, r35). When
    // the snapshot cannot be redacted provably clean, it is still discarded.
    redactReplaySnapshot(db, roomId, ids, removedTexts);
  } catch (error) {
    if (!/no such table/i.test(error?.message ?? "")) throw error;
  }
  try {
    db.prepare(
      "UPDATE room_attachments SET state='deleted', bytes=NULL, filename='purged' WHERE room_id=? AND message_id=? AND state IN ('staged','committed')"
    ).run(roomId, messageId);
  } catch (error) {
    if (!/no such (table|column)/i.test(error?.message ?? "")) throw error;
  }
  // A code drop's card is its message: deleting the card removes the drop's
  // metadata (title, commit subjects, paths) and its checks with the bytes.
  try {
    const drops = db.prepare("SELECT id FROM room_code_drops WHERE room_id=? AND message_id=?").all(roomId, messageId);
    for (const { id } of drops) db.prepare("DELETE FROM room_code_checks WHERE room_id=? AND drop_id=?").run(roomId, id);
    db.prepare("DELETE FROM room_code_drops WHERE room_id=? AND message_id=?").run(roomId, messageId);
  } catch (error) {
    if (!/no such table/i.test(error?.message ?? "")) throw error;
  }
  try { db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(roomId); }
  catch (error) {
    if (!/no such table/i.test(error?.message ?? "")) throw error;
  }

  const stored = compact(next);
  if (!isRoomArchived(state)) {
    db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, storedProjection(db, roomId, stored, { enabled: bodiesAtRest }), roomId);
  }
  return { state: stored, sequence, rewritten };
}

// The messages backfill resumes from cursor.state_json (a compact replay state
// at state_seq). Null the deleted message's text in that state; if any text
// the message carried still appears anywhere in the snapshot (a quote, a
// receipt, an unexpected field), discard the snapshot as before so the next
// backfill rebuilds it from the redacted log. Never keeps a snapshot that
// still holds removed text.
function redactReplaySnapshot(db, roomId, ids, removedTexts) {
  const cursor = db.prepare("SELECT state_json FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
  if (!cursor) return;
  const discard = () => {
    db.prepare("UPDATE messages_backfill_cursor SET state_json=NULL, state_seq=0, parity_at_seq=NULL WHERE room_id=?").run(roomId);
    // A split snapshot (cursor parts, research r21) goes with its marker.
    try { db.prepare("DELETE FROM messages_backfill_state WHERE room_id=?").run(roomId); }
    catch (error) { if (!/no such table/i.test(error?.message ?? "")) throw error; }
  };
  if (typeof cursor.state_json !== "string") return discard();
  let state;
  try { state = JSON.parse(cursor.state_json); } catch { return discard(); }
  if (!state || !Array.isArray(state.messages)) return discard();
  for (const message of state.messages) {
    if (!message || !ids.includes(message.id)) continue;
    if (typeof message.body === "string") removedTexts.push(message.body);
    for (const entry of Array.isArray(message.editHistory) ? message.editHistory : []) {
      if (typeof entry?.body === "string") removedTexts.push(entry.body);
    }
    message.body = null;
    message.redacted = true;
    if (Array.isArray(message.editHistory)) message.editHistory = message.editHistory.map(entry => ({ ...entry, body: null }));
    if (message.attachments != null) message.attachments = null;
  }
  // Any string left in the state that is (or, for texts of 8+ characters,
  // contains) a removed text keeps the old behaviour: discard. Short texts
  // compare whole so "ok" does not match every "token".
  const texts = [...new Set(removedTexts.filter(text => typeof text === "string" && text))];
  const holdsRemovedText = value => {
    if (typeof value === "string") return texts.some(text => (text.length >= 8 ? value.includes(text) : value === text));
    if (Array.isArray(value)) return value.some(holdsRemovedText);
    if (value && typeof value === "object") return Object.entries(value).some(([key, inner]) => holdsRemovedText(key) || holdsRemovedText(inner));
    return false;
  };
  if (holdsRemovedText(state)) return discard();
  db.prepare("UPDATE messages_backfill_cursor SET state_json=?, parity_at_seq=NULL WHERE room_id=?").run(JSON.stringify(state), roomId);
  // The kept snapshot supersedes any split-snapshot parts left from a large
  // pre-redaction write (research r21): purge them the way discard() does, so
  // no part can hold text this redaction just removed. Pre-r21 databases have
  // no messages_backfill_state table.
  try { db.prepare("DELETE FROM messages_backfill_state WHERE room_id=?").run(roomId); }
  catch (error) { if (!/no such table/i.test(error?.message ?? "")) throw error; }
}

// Account deletion also clears dm.posted and any string body the per-message
// pass did not own. Replay accepts body null with redacted true.
export function redactRemainingMessageBodies(db, roomId) {
  const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id=?").all(roomId);
  const update = db.prepare("UPDATE events SET body=? WHERE room_id=? AND sequence=?");
  let rewritten = 0;
  for (const row of rows) {
    const entry = parseEvent(row.body);
    if (!entry?.data) continue;
    if (entry.type !== EVENT_TYPES.MESSAGE_POSTED && entry.type !== EVENT_TYPES.MESSAGE_EDITED && entry.type !== EVENT_TYPES.DM_POSTED) continue;
    if (typeof entry.data.body !== "string") continue;
    entry.data.body = null;
    entry.data.redacted = true;
    if (Object.hasOwn(entry.data, "attachments") && entry.data.attachments != null) entry.data.attachments = null;
    update.run(JSON.stringify(entry), roomId, row.sequence);
    rewritten += 1;
  }
  // These bodies are not tied to one message's snapshot redaction: discard
  // the replay snapshot so no removed text survives in it.
  if (rewritten) {
    try { db.prepare("UPDATE messages_backfill_cursor SET state_json=NULL, state_seq=0, parity_at_seq=NULL WHERE room_id=?").run(roomId); }
    catch (error) { if (!/no such table/i.test(error?.message ?? "")) throw error; }
  }
  return rewritten;
}
