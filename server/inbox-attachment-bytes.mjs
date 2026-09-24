// Identity-scoped inbox attachment bytes for an enrolled agent.
//
// GET /api/inbox/sources/:sourceId/attachments and
// GET /api/inbox/sources/:sourceId/attachments/:attachmentId stay
// account-session descriptor routes. They do not retain provider bytes
// (attachment_bytes_not_retained) and an identity secret is not an account
// session, so this module does not call them and does not fetch Gmail or
// Graph. There is no HTTP upload or discard route. Hosted MCP calls this
// store directly.
//
// Caps match room files (attachmentLimits): 1 MiB per file, 8 MiB and 32
// staged files per identity, 4096 rows per identity, 24 hours while staged.

import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { attachmentLimits } from "./attachment-schema.mjs";
import { validateAttachment, AttachmentError } from "./attachments.mjs";
import { validAttachmentData } from "./room-attachment-bytes.mjs";
import { validId } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

const IDENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

const BLOCKED_MEDIA_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sh",
  "application/x-bat",
  "application/x-csh",
  "text/x-shellscript"
]);

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export const inboxAttachmentBytesSchema = `
  CREATE TABLE IF NOT EXISTS inbox_attachment_bytes (
    identity_id TEXT NOT NULL, id TEXT NOT NULL,
    filename TEXT NOT NULL, media_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=${attachmentLimits.fileBytes}),
    sha256 TEXT NOT NULL CHECK(length(sha256)=64), bytes BLOB,
    state TEXT NOT NULL CHECK(state IN ('staged','discarded','expired')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(identity_id, id),
    CHECK((state='staged' AND bytes IS NOT NULL AND length(bytes)=byte_length)
      OR (state!='staged' AND bytes IS NULL))
  );
  CREATE INDEX IF NOT EXISTS inbox_attachment_bytes_owner ON inbox_attachment_bytes(identity_id, state);
`;

function decodeData(value) {
  if (!validAttachmentData(value)) fail(422, "invalid_attachment", "data must be canonical base64 with no whitespace");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(422, "invalid_attachment", "data must be canonical base64 with no whitespace");
  if (bytes.length > attachmentLimits.fileBytes) fail(413, "attachment_too_large", "File exceeds the inbox attachment size limit");
  return bytes;
}

function checkedFile(filename, mediaType, bytes) {
  let validated;
  try {
    validated = validateAttachment({ filename, sizeBytes: bytes.length, mimeType: mediaType }, { maxFileBytes: attachmentLimits.fileBytes });
  } catch (error) {
    if (!(error instanceof AttachmentError)) throw error;
    fail(error.code === "file_too_large" ? 413 : 422, error.code, error.message);
  }
  if (!validated.filename.isWellFormed()) fail(422, "invalid_attachment", "filename must be well-formed text");
  const type = validated.mimeType.toLowerCase();
  if (!MEDIA_TYPE.test(type) || BLOCKED_MEDIA_TYPES.has(type) || type.startsWith("application/x-ms") || type.startsWith("application/x-dos")) {
    fail(422, "blocked_media_type", "That media type is not accepted for an inbox attachment");
  }
  return { filename: validated.filename, mediaType: type };
}

function view(row) {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    byteLength: row.byte_length,
    sha256: row.sha256,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

export class InboxAttachmentBytes {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = inboxAttachmentBytesSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Inbox attachment schema requires operator reconciliation");
    }
    return true;
  }

  expire(identityId, now) {
    this.db.prepare(`UPDATE inbox_attachment_bytes SET state='expired', bytes=NULL
      WHERE identity_id=? AND state='staged' AND expires_at<=?`).run(identityId, now);
  }

  identity(identityId) {
    if (typeof identityId !== "string" || !IDENTITY_ID.test(identityId)) fail(401, "unauthenticated", "Unknown identity");
    return identityId;
  }

  put(identityId, { id, filename, mediaType, data } = {}) {
    return this.store.transaction(() => {
      const owner = this.identity(identityId);
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      const now = this.store.now();
      this.expire(owner, now);
      const bytes = decodeData(data);
      const file = checkedFile(filename, mediaType, bytes);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const existing = this.db.prepare("SELECT * FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner, id);
      if (existing) {
        const same = existing.state === "staged" && existing.filename === file.filename
          && existing.media_type === file.mediaType && existing.sha256 === sha && existing.byte_length === bytes.length;
        if (same) return { status: "staged", duplicate: true, attachment: view(existing) };
        fail(409, "attachment_conflict", "That attachment id is already stored for this identity");
      }
      const usage = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN state='staged' THEN byte_length ELSE 0 END), 0) AS stagedBytes,
        COALESCE(SUM(CASE WHEN state='staged' THEN 1 ELSE 0 END), 0) AS stagedCount,
        COUNT(*) AS records
        FROM inbox_attachment_bytes WHERE identity_id=?`).get(owner);
      if (usage.stagedBytes + bytes.length > attachmentLimits.memberBytes
        || usage.stagedCount + 1 > attachmentLimits.stagedPerMember
        || usage.records + 1 > attachmentLimits.recordsPerRoom) {
        fail(409, "attachment_quota", "This identity cannot store another inbox attachment of that size");
      }
      const expiresAt = now + attachmentLimits.lifetimeMs;
      this.db.prepare(`INSERT INTO inbox_attachment_bytes(
        identity_id,id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,'staged',?,?)`).run(
        owner, id, file.filename, file.mediaType, bytes.length, sha, bytes, now, expiresAt
      );
      const row = this.db.prepare("SELECT * FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner, id);
      return { status: "staged", duplicate: false, attachment: view(row) };
    });
  }

  list(identityId) {
    return this.store.transaction(() => {
      const owner = this.identity(identityId);
      this.expire(owner, this.store.now());
      const attachments = this.db.prepare(`SELECT * FROM inbox_attachment_bytes
        WHERE identity_id=? AND state='staged'
        ORDER BY created_at DESC, id`).all(owner).map(view);
      return { attachments };
    });
  }

  get(identityId, id) {
    return this.store.transaction(() => {
      const owner = this.identity(identityId);
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      this.expire(owner, this.store.now());
      const row = this.db.prepare("SELECT * FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      if (row.state !== "staged" || row.bytes == null) {
        fail(410, "attachment_unavailable", "Attachment bytes are no longer available");
      }
      return {
        attachment: { ...view(row), encoding: "base64", data: Buffer.from(row.bytes).toString("base64") }
      };
    });
  }

  discard(identityId, id) {
    return this.store.transaction(() => {
      const owner = this.identity(identityId);
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      const now = this.store.now();
      this.expire(owner, now);
      const row = this.db.prepare("SELECT * FROM inbox_attachment_bytes WHERE identity_id=? AND id=?").get(owner, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      if (row.state !== "staged") fail(410, "attachment_unavailable", "Only a staged inbox attachment can be discarded");
      const changed = this.db.prepare(`UPDATE inbox_attachment_bytes SET state='discarded', bytes=NULL
        WHERE identity_id=? AND id=? AND state='staged'`).run(owner, id).changes;
      if (changed !== 1) fail(409, "attachment_conflict", "That attachment changed before it could be discarded");
      return { status: "discarded", id };
    });
  }
}
