// PRIV-1: rewrite a message out of the log, the projection, and the messages
// table in one transaction. Read-time masking stays; this is the write that
// makes the old text unreadable in storage.

import { applyEvent, event, EVENT_TYPES, isRoomArchived } from "../src/events.js";

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
export function commitMessageRedaction(db, { roomId, state, actorId, at, messageId }) {
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
    }
  }

  const ids = messageId.endsWith(":channel") ? [messageId] : [messageId, `${messageId}:channel`];
  try {
    db.prepare(`UPDATE messages SET body=NULL, deleted_at=COALESCE(deleted_at, ?) WHERE room_id=? AND message_id IN (${ids.map(() => "?").join(",")})`).run(at, roomId, ...ids);
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
  try { db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(roomId); }
  catch (error) {
    if (!/no such table/i.test(error?.message ?? "")) throw error;
  }

  const stored = compact(next);
  if (!isRoomArchived(state)) {
    db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, JSON.stringify(stored), roomId);
  }
  return { state: stored, sequence, rewritten };
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
  return rewritten;
}
