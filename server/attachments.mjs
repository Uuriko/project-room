// Staging implementation. Not wired into RoomStore startup or HTTP yet: the
// versioned migration/recovery contract must land before application use.
import { createHash } from 'node:crypto';
import { ServiceError } from './store.mjs';
import { validId } from '../src/events.js';

export const attachmentLimits = Object.freeze({ fileBytes: 1048576, roomBytes: 16777216,
  memberBytes: 8388608, stagedPerMember: 32, recordsPerRoom: 4096, lifetimeMs: 86400000 });
export const attachmentSchema = `CREATE TABLE room_attachments (
  room_id TEXT NOT NULL REFERENCES rooms(id), id TEXT NOT NULL,
  uploader_id TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=1048576),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64), bytes BLOB,
  state TEXT NOT NULL CHECK(state IN ('staged','discarded','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(room_id,id),
  CHECK((state='staged' AND bytes IS NOT NULL AND length(bytes)=byte_length)
    OR (state!='staged' AND bytes IS NULL))
);
CREATE INDEX room_attachments_owner ON room_attachments(room_id,uploader_id,state);`;
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
  stage(token, roomId, input, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      validate(input);
      const now = this.store.now(), hash = digest(input.bytes);
      const prior = this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, input.id);
      if (prior) {
        if (prior.uploader_id !== auth.member.id || prior.filename !== input.filename || prior.media_type !== input.mediaType
          || prior.byte_length !== input.bytes.byteLength || prior.sha256 !== hash)
          fail(409, 'attachment_conflict', 'Upload identity already used');
        if (stateAt(prior, now) !== 'staged') fail(410, 'attachment_unavailable', 'Upload is no longer available');
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
      const copy = new Uint8Array(input.bytes);
      const bytes = this.db.storage ? copy.buffer : copy;
      this.db.prepare('INSERT INTO room_attachments VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(roomId, input.id,
        auth.member.id, input.filename, input.mediaType, input.bytes.byteLength, hash,
        bytes, 'staged', now, now + attachmentLimits.lifetimeMs);
      return view(this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, input.id), now);
    });
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
      if (row.state === 'staged') this.db.prepare("UPDATE room_attachments SET state=?,bytes=NULL WHERE room_id=? AND id=?")
        .run(stateAt(row, this.store.now()) === 'expired' ? 'expired' : 'discarded', roomId, id);
      return view(this.db.prepare('SELECT * FROM room_attachments WHERE room_id=? AND id=?').get(roomId, id), this.store.now());
    });
  }
}
