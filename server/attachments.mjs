// Room-owned staging. HTTP and committed-message integration remain separate.
import { createHash } from 'node:crypto';
import { ServiceError } from './store.mjs';
import { validId } from '../src/events.js';

export const attachmentLimits = Object.freeze({ fileBytes: 1048576, roomBytes: 16777216,
  memberBytes: 8388608, stagedPerMember: 32, recordsPerRoom: 4096, lifetimeMs: 86400000 });
export const attachmentSchemaV28 = `CREATE TABLE room_attachments (
  room_id TEXT NOT NULL REFERENCES rooms(id), id TEXT NOT NULL,
  uploader_id TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=${attachmentLimits.fileBytes}),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64), bytes BLOB,
  state TEXT NOT NULL CHECK(state IN ('staged','discarded','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(room_id,id),
  CHECK((state='staged' AND bytes IS NOT NULL AND length(bytes)=byte_length)
    OR (state!='staged' AND bytes IS NULL))
);
CREATE INDEX room_attachments_owner ON room_attachments(room_id,uploader_id,state);`;
export const attachmentSchema = attachmentSchemaV28
  .replace("'staged','discarded','expired'", "'staged','discarded','expired','committed','deleted'")
  .replace('created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,', 'created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, message_id TEXT,')
  .replace("state='staged' AND bytes", "state IN ('staged','committed') AND bytes")
  .replace("state!='staged' AND bytes", "state NOT IN ('staged','committed') AND bytes");
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stateAt = (row, now) => row.state === 'staged' && row.expires_at <= now ? 'expired' : row.state;
const view = (row, now) => ({ id: row.id, roomId: row.room_id, uploaderId: row.uploader_id,
  filename: row.filename, mediaType: row.media_type, byteLength: row.byte_length,
  sha256: row.sha256, state: stateAt(row, now), createdAt: row.created_at, expiresAt: row.expires_at });
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 4 || !['id', 'filename', 'mediaType', 'bytes'].every(k => Object.hasOwn(input, k))
    || !validId(input.id) || typeof input.filename !== 'string'
    || !input.filename.trim() || input.filename !== input.filename.trim()
    || ['.', '..'].includes(input.filename) || /[\x00-\x1f\x7f-\x9f/\\\u202a-\u202e\u2066-\u2069]/u.test(input.filename)
    || Buffer.byteLength(input.filename, 'utf8') > 255
    || typeof input.mediaType !== 'string' || input.mediaType.length > 127
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(input.mediaType)
    || !(input.bytes instanceof Uint8Array)) fail(422, 'invalid_attachment', 'Choose a file with a valid name and type');
  if (input.bytes.byteLength > attachmentLimits.fileBytes) fail(413, 'attachment_too_large', 'File exceeds the current 1 MiB limit');
}

export class RoomAttachments {
  constructor(store) { this.store = store; this.db = store.db; }
  migrateV28() {
    if (this.db.prepare("SELECT sql FROM sqlite_master WHERE name='room_attachments'").get()?.sql !== attachmentSchemaV28.split(';')[0])
      throw new Error('Attachment migration requires operator reconciliation');
    this.db.exec('ALTER TABLE room_attachments RENAME TO attachment_migration_v28; DROP INDEX room_attachments_owner');
    this.db.exec(attachmentSchema);
    this.db.exec(`INSERT INTO room_attachments SELECT room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,NULL FROM attachment_migration_v28;
      DROP TABLE attachment_migration_v28`);
  }
  verify() {
    const expected = attachmentSchema.split(';')[0];
    if (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_attachments'").get()?.sql !== expected)
      throw new Error('Attachment schema requires operator reconciliation');
    if (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='room_attachments_owner'").get()?.sql !== attachmentSchema.split(';')[1].trim())
      throw new Error('Attachment index requires operator reconciliation');
  }
  audit() {
    this.verify();
    const rows = [];
    const roomMessages = new Map();
    const messagesFor = roomId => {
      if (!roomMessages.has(roomId)) roomMessages.set(roomId, this.store.room(roomId).state.messages);
      return roomMessages.get(roomId);
    };
    // Fetch payloads individually; do not materialize all room bytes at once.
    for (const key of this.db.prepare('SELECT room_id,id FROM room_attachments ORDER BY room_id,id').all()) {
      const row = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(key.room_id, key.id);
      const bytes = row.bytes === null ? null : new Uint8Array(row.bytes);
      if (!validId(row.id) || !this.store.roomAuthority(row.room_id).members[row.uploader_id]
        || !Number.isSafeInteger(row.created_at) || row.expires_at !== row.created_at + attachmentLimits.lifetimeMs
        || !/^[a-f0-9]{64}$/.test(row.sha256)
        || bytes && (bytes.byteLength !== row.byte_length || digest(bytes) !== row.sha256))
        throw new Error('Attachment data requires operator reconciliation');
      validate({ id: row.id, filename: row.filename, mediaType: row.media_type, bytes: bytes ?? new Uint8Array() });
      if (['committed', 'deleted'].includes(row.state)) {
        const message = messagesFor(row.room_id).find(message => message.id === row.message_id);
        const file = message?.attachments?.find(file => file.id === row.id);
        if (!message || message.authorId !== row.uploader_id || !file || file.sha256 !== row.sha256
          || file.filename !== row.filename || file.mediaType !== row.media_type || file.byteLength !== row.byte_length
          || Boolean(message.deletedAt) !== (row.state === 'deleted')) throw new Error('Attachment message reference requires operator reconciliation');
      } else if (row.message_id !== null) throw new Error('Uncommitted attachment has a message reference');
      const { message_id, ...data } = row;
      rows.push({ ...data, ...(message_id === null ? {} : { message_id }), bytes: bytes === null ? null : { byteLength: bytes.byteLength, sha256: digest(bytes) } });
    }
    const indexed = new Map(rows.map(row => [JSON.stringify([row.room_id,row.id]), row]));
    for (const room of this.db.prepare('SELECT id FROM rooms').all()) for (const message of messagesFor(room.id)) {
      for (const file of message.attachments ?? []) {
        const row = indexed.get(JSON.stringify([room.id,file.id]));
        if (!row || row.message_id !== message.id || !['committed','deleted'].includes(row.state))
          throw new Error('Message attachment missing from storage');
      }
    }
    return rows;
  }
  stage(token, roomId, input, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      validate(input);
      // Freeze the exact view before computing the digest. Shared-memory callers
      // cannot change bytes between hashing and persistence.
      const copy = new Uint8Array(input.bytes);
      const now = this.store.now(), hash = digest(copy);
      const prior = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, input.id);
      if (prior) {
        if (prior.uploader_id !== auth.member.id || prior.filename !== input.filename || prior.media_type !== input.mediaType
          || prior.byte_length !== input.bytes.byteLength || prior.sha256 !== hash)
          fail(409, 'attachment_conflict', 'Upload identity already used');
        if (!['staged', 'committed'].includes(stateAt(prior, now))) fail(410, 'attachment_unavailable', 'Upload is no longer available');
        return view(prior, now);
      }
      // Logical expiry is checked on every read. Physical expiry happens only
      // inside a write; failed writes roll it back with the new upload.
      this.db.prepare("UPDATE room_attachments SET state='expired',bytes=NULL WHERE room_id=? AND state='staged' AND expires_at<=?").run(roomId, now);
      const totals = this.db.prepare(`SELECT count(*) records, coalesce(sum(length(bytes)),0) room_bytes,
        coalesce(sum(CASE WHEN uploader_id=? THEN length(bytes) ELSE 0 END),0) member_bytes,
        sum(CASE WHEN uploader_id=? AND state='staged' THEN 1 ELSE 0 END) staged
        FROM room_attachments WHERE room_id=?`).get(auth.member.id, auth.member.id, roomId);
      if (totals.records >= attachmentLimits.recordsPerRoom || totals.staged >= attachmentLimits.stagedPerMember
        || totals.room_bytes + input.bytes.byteLength > attachmentLimits.roomBytes
        || totals.member_bytes + input.bytes.byteLength > attachmentLimits.memberBytes)
        fail(409, 'attachment_capacity', 'Attachment capacity reached');
      // Node binds a byte view; Durable SQLite binds its exact ArrayBuffer.
      // Copy first so a sliced caller buffer cannot persist adjacent bytes.
      const bytes = this.db.storage ? copy.buffer : copy;
      this.db.prepare('INSERT INTO room_attachments(room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(roomId, input.id,
        auth.member.id, input.filename, input.mediaType, input.bytes.byteLength, hash,
        bytes, 'staged', now, now + attachmentLimits.lifetimeMs);
      return view(this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, input.id), now);
    });
  }
  bindMessage(roomId, uploaderId, ids, messageId) {
    if (!this.db.isTransaction || this.db.readOnlyTransaction) throw new Error('Attachment commitment requires a write transaction');
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => !validId(id)) || !validId(messageId))
      fail(422, 'invalid_attachments', 'Choose up to four unique files and a message identity');
    return ids.map(id => {
      const row = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, id);
      if (!row || row.uploader_id !== uploaderId || stateAt(row, this.store.now()) !== 'staged')
        fail(409, 'attachment_unavailable', 'A selected upload is unavailable');
      const bytes = new Uint8Array(row.bytes);
      if (digest(bytes) !== row.sha256) fail(500, 'attachment_corrupt', 'File could not be verified');
      this.db.prepare("UPDATE room_attachments SET state='committed',message_id=? WHERE room_id=? AND id=?").run(messageId, roomId, id);
      return { id, filename: row.filename, mediaType: row.media_type, byteLength: row.byte_length, sha256: row.sha256 };
    });
  }
  deleteForMessage(roomId, messageId) {
    if (!this.db.isTransaction || this.db.readOnlyTransaction) throw new Error('Attachment deletion requires a write transaction');
    this.db.prepare("UPDATE room_attachments SET state='deleted',bytes=NULL WHERE room_id=? AND message_id=? AND state='committed'").run(roomId, messageId);
  }
  readCommitted(token, roomId, id, binding = null) {
    return this.store.readTransaction(() => {
      this.store.authenticate(token, roomId, binding);
      const row = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, id);
      const message = row && this.store.room(roomId).state.messages.find(message => message.id === row.message_id);
      if (!row || row.state !== 'committed' || !message || message.deletedAt || !message.attachments?.some(file => file.id === id && file.sha256 === row.sha256))
        fail(404, 'attachment_unavailable', 'File unavailable');
      const bytes = new Uint8Array(row.bytes);
      if (bytes.byteLength !== row.byte_length || digest(bytes) !== row.sha256) fail(500, 'attachment_corrupt', 'File could not be verified');
      return { attachment: { ...view(row, this.store.now()), messageId: row.message_id }, bytes };
    });
  }
  retireMember(roomId, memberId) {
    if (!this.db.isTransaction || this.db.readOnlyTransaction) throw new Error('Attachment retirement requires a write transaction');
    this.db.prepare(`UPDATE room_attachments SET state='discarded',bytes=NULL WHERE room_id=? AND state='staged'
      AND (uploader_id=? OR uploader_id IN (SELECT member_id FROM agent_connections WHERE room_id=? AND sponsor_member_id=?))`)
      .run(roomId, memberId, roomId, memberId);
  }
  retireAccount(accountId) {
    for (const row of this.db.prepare(`SELECT room_id,member_id FROM member_accounts WHERE account_id=?
      UNION SELECT room_id,member_id FROM agent_connections WHERE sponsor_account_id=?`).all(accountId, accountId))
      this.retireMember(row.room_id, row.member_id);
  }
  readStaged(token, roomId, id, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const row = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, id);
      if (!row || row.uploader_id !== auth.member.id || stateAt(row, this.store.now()) !== 'staged')
        fail(404, 'attachment_unavailable', 'Upload unavailable');
      const bytes = new Uint8Array(row.bytes);
      if (bytes.byteLength !== row.byte_length || digest(bytes) !== row.sha256)
        fail(500, 'attachment_corrupt', 'File could not be verified');
      return { attachment: view(row, this.store.now()), bytes };
    });
  }
  discard(token, roomId, id, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const row = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, id);
      if (!row || row.uploader_id !== auth.member.id) fail(404, 'attachment_unavailable', 'Upload unavailable');
      if (row.state === 'committed') fail(409, 'attachment_committed', 'Remove the message to delete its file');
      if (row.state === 'staged') this.db.prepare("UPDATE room_attachments SET state=?,bytes=NULL WHERE room_id=? AND id=?")
        .run(stateAt(row, this.store.now()) === 'expired' ? 'expired' : 'discarded', roomId, id);
      return view(this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, id), this.store.now());
    });
  }
}
