// An ordinary native mention callback authorizes a pointer, not message content.
// Every delivery barrier still supplies fresh grant and room policy checks.
import { PILOT_LIMITS } from './store.mjs';
import { hasMessageAuthority } from './message-authority.mjs';
import { decodeMessageEntity } from './message-entity-projection.mjs';
import { assertProjectionWrite, assertMessageWrite, MESSAGE_PROOF_FIELDS } from './write-integrity.mjs';

export function canonicalNativeMentionPolicyContext(store, descriptor, event, context) {
  if (!['mention', 'squad-mention'].includes(context.kind)
    || event?.name !== 'room.requested' || event.data?.roomId !== descriptor.roomId
    || event.data?.memberId !== descriptor.memberId || typeof event.data?.messageId !== 'string') return null;
  const db = store.db, roomId = descriptor.roomId, id = event.data.messageId, cap = PILOT_LIMITS.projectionBytes;
  // A legacy room must never return its inline history into this helper. Admit
  // every scalar used by the existing metadata proof before loading its bytes.
  const admission = db.prepare(`SELECT length(CAST(r.projection AS BLOB)) AS projection_bytes,
    length(CAST(i.metadata_hash AS BLOB)) AS metadata_hash_bytes,
    COALESCE(length(CAST(i.projection_hash AS BLOB)),0) AS projection_hash_bytes,
    COALESCE(length(CAST(i.sequence AS BLOB)),0) AS sequence_bytes
    FROM rooms r LEFT JOIN integrity_room_state i ON i.room_id=r.id
    WHERE r.id=? AND json_type(r.projection,'$.messageAuthority') IS NOT NULL`).get(roomId);
  if (!admission || admission.metadata_hash_bytes === null) return null;
  if (admission.metadata_hash_bytes !== 64) throw Error('projection_corrupt: invalid metadata write proof');
  if (Object.values(admission).some(size => !Number.isSafeInteger(size) || size < 0))
    throw Error('projection_corrupt: invalid metadata scalar size');
  if (Object.values(admission).reduce((sum, size) => sum + size, 0) > cap) {
    // The full fallback is outside the byte qualification, but exceeding a
    // budget must not erase a known proof and make corruption look absent.
    assertProjectionWrite(db, roomId); return null;
  }
  assertProjectionWrite(db, roomId);
  const raw = JSON.parse(db.prepare('SELECT projection FROM rooms WHERE id=?').get(roomId).projection);
  if (!hasMessageAuthority(raw)) return null;
  if (Object.hasOwn(raw, 'messages')) throw Error('projection_corrupt: competing canonical message array');
  if (raw.messagesArchive || raw.room?.archivedAt || raw.room?.starterSeeded
    || raw.room?.publicPage?.enabled || raw.room?.publicReceipts?.enabled) return null;
  const fields = [...MESSAGE_PROOF_FIELDS, 'entity_hash'];
  const sizes = db.prepare(`SELECT ${fields.map(field => `COALESCE(length(CAST(${field} AS BLOB)),0) AS ${field}_bytes`).join(',')}
    FROM messages WHERE room_id=? AND message_id=?`).get(roomId, id);
  if (!sizes) return null;
  if (Object.values(sizes).some(size => !Number.isSafeInteger(size) || size < 0))
    throw Error('projection_corrupt: invalid message scalar size');
  if (Object.values(sizes).reduce((sum, size) => sum + size, 0) > cap) {
    assertMessageWrite(db, roomId, id); return null;
  }
  // Check a present entity before classifying it as an unsupported shape; a
  // corrupt edited/deleted flag must not masquerade as permissive absence.
  assertMessageWrite(db, roomId, id);
  const row = db.prepare(`SELECT message_id,body,record_json,reducer_extras_json,author_id,
    reply_to_id,to_member_id,work_item_id,edited_at,deleted_at FROM messages WHERE room_id=? AND message_id=?`).get(roomId, id);
  const message = decodeMessageEntity(row);
  if (row.author_id !== context.actorId || row.reply_to_id || row.to_member_id || row.work_item_id
    || row.edited_at || row.deleted_at || message.kind || message.replyToId || message.toMemberId || message.workItemId) return null;
  // No payload or history escapes this context. A later content fetch retains
  // its own DM/history authorization; edited/deleted/missing pointers use the
  // original full callback policy rather than acquiring a new refusal rule.
  return { room: raw.room, members: raw.members };
}
