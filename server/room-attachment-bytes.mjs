// Room file bytes on the existing room_attachments table.
//
// attachment-schema.mjs owns the table, the byte caps, and the staged /
// committed / discarded / expired / deleted states. This module is the store
// API those rows were missing: stage, list, download, discard, and commit.
// Commit sets message_id and state committed on a staged row. It does not
// add a second blob store and it does not post a chat message. Provider
// inbox descriptors stay on the account-session routes and do not retain
// bytes. Identity-staged inbox bytes live in inbox_attachment_bytes.

import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { attachmentLimits } from "./attachment-schema.mjs";
import { validateAttachment, AttachmentError } from "./attachments.mjs";
import { validId } from "../src/events.js";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

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

export function base64LengthForBytes(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

// MCP JSON bodies that carry one max-size file, plus a small envelope.
export const mcpAttachmentBodyBytes = base64LengthForBytes(attachmentLimits.fileBytes) + 8192;

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

export function validAttachmentData(value) {
  if (typeof value !== "string" || value.length > base64LengthForBytes(attachmentLimits.fileBytes)) return false;
  if (value.length % 4 !== 0) return false;
  if (value.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return true;
}

function decodeData(value) {
  if (!validAttachmentData(value)) fail(422, "invalid_attachment", "data must be canonical base64 with no whitespace");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(422, "invalid_attachment", "data must be canonical base64 with no whitespace");
  if (bytes.length > attachmentLimits.fileBytes) fail(413, "attachment_too_large", "File exceeds the room attachment size limit");
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
    fail(422, "blocked_media_type", "That media type is not accepted for a room file");
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
    uploaderId: row.uploader_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    messageId: row.message_id ?? null
  };
}

export class RoomAttachmentBytes {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  expire(roomId, now) {
    this.db.prepare(`UPDATE room_attachments SET state='expired', bytes=NULL
      WHERE room_id=? AND state='staged' AND expires_at<=?`).run(roomId, now);
  }

  stage(token, roomId, { id, filename, mediaType, data } = {}) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "room_put_file", fail });
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      const now = this.store.now();
      this.expire(roomId, now);
      const bytes = decodeData(data);
      const file = checkedFile(filename, mediaType, bytes);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const existing = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      if (existing) {
        const same = existing.state === "staged" && existing.uploader_id === auth.member.id
          && existing.filename === file.filename && existing.media_type === file.mediaType
          && existing.sha256 === sha && existing.byte_length === bytes.length;
        if (same) return { status: "staged", duplicate: true, roomId, attachment: view(existing) };
        fail(409, "attachment_conflict", "That attachment id is already in this room");
      }
      const usage = this.db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN state IN ('staged','committed') THEN byte_length ELSE 0 END), 0) AS roomBytes,
        COALESCE(SUM(CASE WHEN state IN ('staged','committed') AND uploader_id=? THEN byte_length ELSE 0 END), 0) AS memberBytes,
        COALESCE(SUM(CASE WHEN state='staged' AND uploader_id=? THEN 1 ELSE 0 END), 0) AS stagedCount,
        COUNT(*) AS records
        FROM room_attachments WHERE room_id=?`).get(auth.member.id, auth.member.id, roomId);
      if (usage.roomBytes + bytes.length > attachmentLimits.roomBytes
        || usage.memberBytes + bytes.length > attachmentLimits.memberBytes
        || usage.stagedCount + 1 > attachmentLimits.stagedPerMember
        || usage.records + 1 > attachmentLimits.recordsPerRoom) {
        fail(409, "attachment_quota", "This room cannot store another file of that size");
      }
      const expiresAt = now + attachmentLimits.lifetimeMs;
      this.db.prepare(`INSERT INTO room_attachments(
        room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
      ) VALUES(?,?,?,?,?,?,?,?,'staged',?,?,NULL)`).run(
        roomId, id, auth.member.id, file.filename, file.mediaType, bytes.length, sha, bytes, now, expiresAt
      );
      const row = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      return { status: "staged", duplicate: false, roomId, attachment: view(row) };
    });
  }

  // Visibility rule (2026-09-24, #983): a staged file is visible only to
  // its uploader; a file committed onto a DM (toMemberId) is visible only
  // to the message author and recipient. Everything else stays room-wide.
  visibleTo(row, messages, memberId) {
    if (row.state === "staged") return row.uploader_id === memberId;
    if (row.message_id) {
      const message = messages.get(row.message_id);
      if (message?.toMemberId) {
        return message.authorId === memberId || message.toMemberId === memberId;
      }
    }
    return true;
  }

  messageIndex(roomId) {
    return new Map(this.store.room(roomId).state.messages.map(entry => [entry.id, entry]));
  }

  list(token, roomId) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      this.expire(roomId, this.store.now());
      const messages = this.messageIndex(roomId);
      const memberId = auth.member.id;
      const files = this.db.prepare(`SELECT * FROM room_attachments
        WHERE room_id=? AND state IN ('staged','committed')
        ORDER BY created_at DESC, id`).all(roomId)
        .filter(row => this.visibleTo(row, messages, memberId))
        .map(view);
      return { roomId, files };
    });
  }

  get(token, roomId, id) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      this.expire(roomId, this.store.now());
      const row = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      if ((row.state !== "staged" && row.state !== "committed") || row.bytes == null) {
        fail(410, "attachment_unavailable", "Attachment bytes are no longer available");
      }
      // Invisible files 404 (not 403) so the id does not leak existence.
      if (!this.visibleTo(row, this.messageIndex(roomId), auth.member.id)) {
        fail(404, "attachment_not_found", "Attachment not found");
      }
      return {
        roomId,
        attachment: { ...view(row), encoding: "base64", data: Buffer.from(row.bytes).toString("base64") }
      };
    });
  }

  discard(token, roomId, id) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "room_discard_file", fail });
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      const now = this.store.now();
      this.expire(roomId, now);
      const row = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      if (row.state !== "staged") fail(410, "attachment_unavailable", "Only a staged room file can be discarded");
      const ownerId = this.store.room(roomId).state.room.ownerId;
      if (row.uploader_id !== auth.member.id && ownerId !== auth.member.id) {
        fail(403, "attachment_forbidden", "Only the uploader or the room owner can discard this file");
      }
      const changed = this.db.prepare(`UPDATE room_attachments SET state='discarded', bytes=NULL
        WHERE room_id=? AND id=? AND state='staged'`).run(roomId, id).changes;
      if (changed !== 1) fail(409, "attachment_conflict", "That attachment changed before it could be discarded");
      return { status: "discarded", roomId, id };
    });
  }

  // Bind a staged file to a chat message the caller already posted.
  // Same id + messageId is a duplicate. A different message does not move it.
  commit(token, roomId, { id, messageId } = {}) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "room_commit_file", fail });
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      if (!validId(messageId)) fail(422, "invalid_message", "Message id is not valid");
      this.expire(roomId, this.store.now());
      const row = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      if (row.uploader_id !== auth.member.id) {
        fail(403, "attachment_forbidden", "Only the uploader can commit this file onto a message");
      }
      if (row.state === "committed" && row.message_id === messageId) {
        return { status: "committed", duplicate: true, roomId, attachment: view(row) };
      }
      if (row.state === "committed") fail(409, "attachment_conflict", "That file is already committed to a message");
      if (row.state !== "staged") fail(410, "attachment_unavailable", "Only a staged room file can be committed");
      const message = this.store.room(roomId).state.messages.find(entry => entry.id === messageId);
      if (!message || message.deletedAt) fail(404, "message_not_found", "Message not found");
      if (message.authorId !== auth.member.id) {
        fail(403, "attachment_forbidden", "Commit a file only onto a message you posted");
      }
      const changed = this.db.prepare(`UPDATE room_attachments SET state='committed', message_id=?
        WHERE room_id=? AND id=? AND state='staged' AND uploader_id=? AND message_id IS NULL`).run(
        messageId, roomId, id, auth.member.id
      ).changes;
      if (changed !== 1) {
        const current = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
        if (current?.state === "committed" && current.message_id === messageId && current.uploader_id === auth.member.id) {
          return { status: "committed", duplicate: true, roomId, attachment: view(current) };
        }
        fail(409, "attachment_conflict", "That attachment changed before it could be committed");
      }
      const committed = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      return { status: "committed", duplicate: false, roomId, attachment: view(committed) };
    });
  }
}
