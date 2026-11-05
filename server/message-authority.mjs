// Canonical message payloads live in messages, not an array of room references.
// This is an internal migration boundary, not an authorization or wire API.
import { decodeMessageEntity } from './message-entity-projection.mjs';
import { assertProjectionWrite, assertMessageWrite } from './write-integrity.mjs';
import { hydrateWorkItems, isWorkReference } from './work-repository.mjs';
import { humanPushRecipients } from './human-push.mjs';

export function hasMessageAuthority(state) {
  if (!Object.hasOwn(state ?? {}, 'messageAuthority')) return false;
  const marker = state.messageAuthority;
  if (!marker || marker.version !== 1 || !Number.isSafeInteger(marker.count) || marker.count < 0
    || Object.keys(marker).some(key => !['version', 'count'].includes(key)))
    throw new Error('projection_corrupt: invalid message authority');
  return true;
}

export function messageAuthorityProjection(state, count = state.messages?.length) {
  if (!hasMessageAuthority(state) || !Array.isArray(state.messages))
    throw new Error('projection_corrupt: missing canonical message context');
  if (!Number.isSafeInteger(count) || count < state.messages.length)
    throw new Error('projection_corrupt: invalid canonical context count');
  const { messages, ...metadata } = state;
  return { ...metadata, messageAuthority: { version: 1, count } };
}

function validateArchive(archive) {
  if (archive && (!Number.isSafeInteger(archive.throughSeq) || archive.throughSeq < 0
    || !Number.isSafeInteger(archive.count) || archive.count < 0
    || !Array.isArray(archive.retainedIds) || archive.retainedIds.some(id => typeof id !== 'string')))
    throw new Error('projection_corrupt: invalid canonical archive');
}

// Full compatibility hydration is explicit. Targeted command/read contexts will
// use point queries; this operation intentionally returns the retained view.
export function hydrateMessageAuthority(db, roomId, state) {
  if (!hasMessageAuthority(state)) return state;
  if (Object.hasOwn(state, 'messages'))
    throw new Error('projection_corrupt: competing canonical message array');
  const archive = state.messagesArchive;
  validateArchive(archive);
  const where = archive ? ' AND (seq>? OR message_id IN (SELECT value FROM json_each(?)))' : '';
  const params = archive ? [roomId, archive.throughSeq, JSON.stringify(archive.retainedIds)] : [roomId];
  const rows = db.prepare(`SELECT message_id,body,record_json,reducer_extras_json FROM messages
    WHERE room_id=?${where} ORDER BY seq,message_id`).all(...params);
  if (rows.length !== state.messageAuthority.count)
    throw new Error('projection_corrupt: canonical message count differs');
  return { ...state, messages: rows.map(decodeMessageEntity) };
}

// First bounded command context: a retained top-level edit changes neither
// message membership nor thread ancestry. Other commands and published rooms
// keep their full context until their own dependency contracts are qualified.
export function canonicalMessageEditContext(db, roomId, command) {
  if (command.type !== 'message.edited' || typeof command.data?.messageId !== 'string') return null;
  const row = db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get(roomId);
  if (!row) return null;
  const raw = JSON.parse(row.projection);
  if (!hasMessageAuthority(raw) || raw.room?.publicPage?.enabled || raw.room?.publicReceipts?.enabled) return null;
  if (Object.hasOwn(raw, 'messages')) throw new Error('projection_corrupt: competing canonical message array');
  validateArchive(raw.messagesArchive);
  const id = command.data.messageId;
  const rows = db.prepare(`SELECT message_id,seq,body,record_json,reducer_extras_json FROM messages
    WHERE room_id=? AND message_id IN (?,?) ORDER BY seq,message_id`).all(roomId,id,`${id}:channel`);
  const target = rows.find(record=>record.message_id===id);
  if (!target) return null;
  const messages = rows.map(decodeMessageEntity);
  if (messages.some(message=>message.replyToId)) return null;
  const archive=raw.messagesArchive;
  if (archive && target.seq<=archive.throughSeq && !archive.retainedIds?.includes(id)) return null;
  return { room: { sequence: row.sequence, state: { ...raw, messages } }, count: raw.messageAuthority.count };
}

// A plain top-level post depends on bounded room metadata and the proposed
// identifier, not retained message payloads. Higher-context paths keep their
// full context. This does not audit unrelated historical rows or certify a
// new baseline: the trusted retained count survives, incremented by one.
export function canonicalMessagePostContext(db, roomId, command, { actorId, humanPushEnabled = false, workLimits } = {}) {
  const data = command.data;
  if (command.type !== 'message.posted' || typeof data?.messageId !== 'string' || !data.messageId
    || typeof data.body !== 'string' || Object.keys(data).some(key => !['messageId', 'body'].includes(key))) return null;
  // Filter in SQL so probing a legacy room never returns/copies its inline
  // history into this helper before taking the unchanged full path.
  const row = db.prepare("SELECT sequence,projection FROM rooms WHERE id=? AND json_type(projection,'$.messageAuthority') IS NOT NULL").get(roomId);
  if (!row) return null;
  const raw = JSON.parse(row.projection);
  if (!hasMessageAuthority(raw) || raw.messagesArchive || raw.room?.archivedAt || raw.room?.starterSeeded
    || raw.room?.publicPage?.enabled || raw.room?.publicReceipts?.enabled) return null;
  if (Object.hasOwn(raw, 'messages')) throw new Error('projection_corrupt: competing canonical message array');
  const work = Object.values(raw.workItems ?? {});
  if (work.some(item => item?.status === 'suspended' && item?.suspended_by === 'round_limit')) return null;
  const assistant = db.prepare('SELECT value FROM room_assistant_config WHERE room_id=?').get(roomId);
  if (assistant) {
    try { if (JSON.parse(assistant.value)?.coordinatorMemberId) return null; }
    catch { return null; }
  }
  // Human push rechecks full visibility asynchronously after commit. Keep that
  // existing path rather than silently doing a whole-room read after admission.
  if (humanPushEnabled && humanPushRecipients({ members: raw.members, senderMemberId: actorId, body: data.body }).length) return null;
  const proof = db.prepare('SELECT metadata_hash FROM integrity_room_state WHERE room_id=?').get(roomId);
  if (!proof?.metadata_hash) return null;
  assertProjectionWrite(db, roomId);
  // Existing retry recovery needs the original thread's full context.
  if (db.prepare('SELECT 1 FROM activity_fanout_failures WHERE room_id=? AND recovered_at IS NULL LIMIT 1').get(roomId)) return null;
  let state = raw;
  if (work.some(isWorkReference)) {
    const countCap = workLimits?.workItemsPerRoom, byteCap = workLimits?.projectionBytes;
    if (!Number.isSafeInteger(countCap) || countCap < 1 || !Number.isSafeInteger(byteCap) || byteCap < 1
      || work.length > countCap) return null;
    // The existing hydrator reads every room work row, including orphans.
    // Admit its entire result before any scalar payload crosses into JS.
    // Reuse pilot budgets as fast-path admission only; larger rooms retain
    // the unchanged full path, not a new storage limit or conversion.
    const sizes = db.prepare(`SELECT length(CAST(work_id AS BLOB)) AS id_bytes,
      length(CAST(revision AS BLOB)) AS revision_bytes, length(CAST(digest AS BLOB)) AS digest_bytes,
      length(CAST(body AS BLOB)) AS body_bytes FROM work_entities WHERE room_id=? LIMIT ?`).all(roomId, countCap + 1);
    if (sizes.length > countCap) return null;
    let bytes = 0;
    for (const row of sizes) for (const size of Object.values(row)) {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('work_projection_corrupt: invalid work scalar size');
      bytes += size;
      if (size > byteCap || bytes > byteCap) return null;
    }
    // Existing content-addressed references check exact IDs, revisions and
    // digests; this post never mints a checksum to establish their trust.
    state = hydrateWorkItems(db, roomId, raw);
    if (Object.values(state.workItems).some(item => item?.status === 'suspended' && item?.suspended_by === 'round_limit')) return null;
  }
  const rows = db.prepare(`SELECT message_id,body,record_json,reducer_extras_json FROM messages
    WHERE room_id=? AND message_id IN (?,?) ORDER BY message_id`).all(roomId, data.messageId, `${data.messageId}:channel`);
  for (const record of rows) assertMessageWrite(db, roomId, record.message_id);
  const count = raw.messageAuthority.count + 1;
  if (!Number.isSafeInteger(count)) throw new Error('projection_corrupt: invalid canonical context count');
  return { room: { sequence: row.sequence, state: { ...state, messages: rows.map(decodeMessageEntity) } }, count };
}
