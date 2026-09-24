// Room-owned staging. HTTP upload routes stay separate.
// server/room-attachment-bytes.mjs is the store API: stage, list, download,
// discard, and commit (message_id + state committed).

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

export function ensureAttachmentSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_attachments'").get();
  if (!row) { db.exec(attachmentSchema); return "created"; }
  const current = row.sql;
  const final = attachmentSchema.split(';')[0];
  if (current === final) return "current";
  if (current !== attachmentSchemaV28.split(';')[0]) throw new Error("Attachment schema requires operator reconciliation");
  db.exec('ALTER TABLE room_attachments RENAME TO attachment_migration_v28; DROP INDEX room_attachments_owner');
  db.exec(attachmentSchema);
  db.exec(`INSERT INTO room_attachments SELECT room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,NULL FROM attachment_migration_v28;
    DROP TABLE attachment_migration_v28`);
  return "migrated";
}

export function verifyAttachmentSchema(db) {
  if (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='room_attachments'").get()?.sql !== attachmentSchema.split(';')[0])
    throw new Error("Attachment schema requires operator reconciliation");
  if (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='room_attachments_owner'").get()?.sql !== attachmentSchema.split(';')[1].trim())
    throw new Error("Attachment index requires operator reconciliation");
}
