import {isCurrentRoom,withCurrentReadContext,readCurrentMessage,currentMessageMayBeVisible,readCurrentHead,readCurrentHistoryFloor,chargeCurrentReadBudget,withCurrentServingWriter} from './current-room-repository.mjs';
import {conversationCursorCodec} from './conversation-sync.mjs';
import {messageInHistory} from './history-visibility.mjs';
import { messageRepository } from "./message-repository.mjs";
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
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

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
// Inventories, authorization and deletion need no byte payload. Downloads
// admit metadata first, then read exactly one authorized blob in the same
// transaction; SQL must not materialize hidden or unrelated file bytes.
const FILE_METADATA = "id,uploader_id,filename,media_type,byte_length,sha256,state,created_at,expires_at,message_id";

// Encoding validity ONLY (#3436): the size cap is not part of this check.
// Folding it in made every over-cap upload report as an encoding error and
// left the 413 branch below unreachable for base64 input.
export function validAttachmentData(value) {
  if (typeof value !== "string") return false;
  if (value.length % 4 !== 0) return false;
  if (value.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return true;
}

// Exact decoded byte count of a well-formed base64 string, computed before
// decoding so an over-cap payload is refused for its size, not its shape.
export function base64DecodedLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeData(value) {
  if (!validAttachmentData(value)) fail(422, "invalid_attachment", "data must be canonical base64 with no whitespace");
  // Size before decode, naming the limit and the actual size (#3436; the AX
  // *_too_large recovery reads the limit from the message).
  const decodedLength = base64DecodedLength(value);
  if (decodedLength > attachmentLimits.fileBytes)
    fail(413, "attachment_too_large", `File is ${decodedLength} bytes; the room attachment size limit is ${attachmentLimits.fileBytes} bytes`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(422, "invalid_attachment", "data must be canonical base64 with no whitespace");
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

  authorityState(roomId, memberId) {
    if (!isCurrentRoom(this.db, roomId)) return this.store.room(roomId).state;
    const authority = this.store.roomAuthority(roomId, { memberId });
    return { room: { id: roomId, ownerId: authority.ownerId }, members: authority.members };
  }

  write(roomId, operation) {
    return withCurrentServingWriter(this.db, roomId, operation);
  }

  expire(roomId, now) {
    return this.store.transaction(() => {
      // Avoid opening an admission receipt when there are no expired bytes.
      if (!this.db.prepare("SELECT 1 FROM room_attachments WHERE room_id=? AND state IN ('staged','committed') AND state='staged' AND expires_at<=? LIMIT 1").get(roomId, now)) return;
      return this.write(roomId, () => this.db.prepare(`UPDATE room_attachments SET state='expired', bytes=NULL
      WHERE room_id=? AND state IN ('staged','committed') AND state='staged' AND expires_at<=?`).run(roomId, now));
    });
  }

  stage(token, roomId, { id, filename, mediaType, data } = {}) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.authorityState(roomId, auth.member.id), actor: auth.member, action: "room_put_file", fail });
      // Guests may read and chat but may not store room files. stage()
      // authenticates directly and bypasses store.command, so the RoomStore
      // guest scope gate never runs here — enforce the same denial
      // explicitly. Mirrors RC-2026-09-27-2716 (PR #1156).
      if (isGuestAgentMemberId(auth.member.id))
        fail(403, "guest_scope_denied", "Guest members cannot stage room files");
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
        COALESCE(SUM(CASE WHEN state IN ('staged','committed') THEN 1 ELSE 0 END), 0) AS records
        FROM room_attachments WHERE room_id=? AND state IN ('staged','committed')`).get(auth.member.id, auth.member.id, roomId);
      // Name the limit that refused, with what is used and what is left, so an
      // agent can split the file or stop instead of retrying blind. Committed
      // files never expire and staged ones count until their staging deadline,
      // so the uploader's own total includes files other members cannot see.
      const limits = [
        ["uploader_bytes", usage.memberBytes, attachmentLimits.memberBytes, bytes.length, "bytes"],
        ["room_bytes", usage.roomBytes, attachmentLimits.roomBytes, bytes.length, "bytes"],
        ["staged_files", usage.stagedCount, attachmentLimits.stagedPerMember, 1, "files"],
        ["room_files", usage.records, attachmentLimits.recordsPerRoom, 1, "files"]
      ];
      const refused = limits.find(([, used, max, adding]) => used + adding > max);
      if (refused) {
        const [limit, used, max, adding, unit] = refused, remaining = Math.max(0, max - used);
        const error = new ServiceError(409, "attachment_quota",
          `This file needs ${adding} ${unit === "bytes" ? "bytes" : "file slot"}; the ${limit.replace("_", " ")} limit has ${remaining} ${unit} left of ${max}. Nothing was stored`);
        error.detail = { quota: { limit, used, max, remaining, requested: adding, unit } };
        throw error;
      }
      const expiresAt = now + attachmentLimits.lifetimeMs;
      this.write(roomId, () => this.db.prepare(`INSERT INTO room_attachments(
        room_id,id,uploader_id,filename,media_type,byte_length,sha256,bytes,state,created_at,expires_at,message_id
      ) VALUES(?,?,?,?,?,?,?,?,'staged',?,?,NULL)`).run(
        roomId, id, auth.member.id, file.filename, file.mediaType, bytes.length, sha, bytes, now, expiresAt
      ));
      const row = this.db.prepare("SELECT * FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      return { status: "staged", duplicate: false, roomId, attachment: view(row) };
    });
  }

  // Visibility rule (2026-09-24, #983): an unbound file stays visible only
  // to its uploader, including after expiry/discard; a file committed onto
  // a DM (toMemberId) is visible only
  // to the message author and recipient. Everything else stays room-wide.
  // Fail closed (#2950): a committed file whose bound message no longer
  // resolves in the projection (history replaced via importEvents, or the
  // projection rebuilt/compacted while the attachment row survived) must
  // not become room-visible — without the message there is no proof the
  // file was not a DM. Only the uploader keeps access: commit() proved
  // the uploader authored the bound message, so they were a party to it
  // whether it was a DM or a public post.
  visibleTo(row, messages, memberId) {
    if (row.state === "staged" || !row.message_id) return row.uploader_id === memberId;
    if (row.message_id) {
      const message = messages.get(row.message_id);
      if (!message) return row.uploader_id === memberId;
      if (message.toMemberId) {
        return message.authorId === memberId || message.toMemberId === memberId;
      }
    }
    return true;
  }

  messageIndex(roomId) {
    if(isCurrentRoom(this.db,roomId))return{get:id=>readCurrentMessage(this.db,roomId,id)?.value};
    const byId = messageRepository(this.store, roomId);
    // A file committed onto an archived DM must keep the DM's visibility rule:
    // a missing message would read as room-wide.
    return byId;
  }

  listCurrent(token,roomId,{messageIds,cursor=null}={}){
    if(!Array.isArray(messageIds)||messageIds.length<1||messageIds.length>8||new Set(messageIds).size!==messageIds.length||messageIds.some(id=>!validId(id)))fail(422,'attachment_selection_required','Select one to eight visible messages for files');
    const ids=[...messageIds].sort();
    return this.store.transaction(()=>withCurrentReadContext(this.db,roomId,b=>{
      const auth=this.store.authenticate(token,roomId),head=readCurrentHead(this.db,roomId),floor=readCurrentHistoryFloor(this.db,roomId,auth.member.id);
      for(const id of ids){if(!currentMessageMayBeVisible(this.db,roomId,id,auth.member.id,undefined,floor))fail(404,'attachment_not_found','Attachment selection not found');const source=readCurrentMessage(this.db,roomId,id),m=source?.value;
        if(!m||!messageInHistory(m,floor)||(m.toMemberId&&m.authorId!==auth.member.id&&m.toMemberId!==auth.member.id))fail(404,'attachment_not_found','Attachment selection not found');}
      const codec=conversationCursorCodec(this.store),scope=createHash('sha256').update(JSON.stringify([roomId,auth.member.id,token,head.head_sha256,ids])).digest('hex');
      let after=['',''];if(cursor!==null){const decoded=codec.decode(cursor);if(decoded?.scope!==scope||!Array.isArray(decoded.after)||decoded.after.length!==2||decoded.after.some(v=>typeof v!=='string'))fail(409,'attachment_cursor_reset','Files changed or the server restarted; refresh this selection');after=decoded.after;}
      const rows=this.db.prepare(`SELECT id,message_id,length(CAST(id AS BLOB))+length(CAST(message_id AS BLOB))+length(CAST(filename AS BLOB))+length(CAST(media_type AS BLOB))+length(CAST(uploader_id AS BLOB))+length(CAST(sha256 AS BLOB))+128 AS metadata_bytes FROM room_attachments INDEXED BY current_room_attachments_message WHERE room_id=? AND message_id IN (${ids.map(()=>'?').join(',')}) AND (message_id,id)>(?,?) ORDER BY message_id,id LIMIT 9`).all(roomId,...ids,...after);
      chargeCurrentReadBudget(b,rows.length*256,rows.length);
      const selected=rows.slice(0,8),files=[];
      for(const key of selected){if(!Number.isSafeInteger(key.metadata_bytes)||key.metadata_bytes>4096)fail(409,'attachment_metadata_unavailable','File metadata requires recovery');chargeCurrentReadBudget(b,key.metadata_bytes);
        const row=this.db.prepare(`SELECT ${FILE_METADATA} FROM room_attachments WHERE room_id=? AND id=?`).get(roomId,key.id);
        if(row?.message_id!==key.message_id)fail(409,'attachment_metadata_unavailable','File selection changed');if(row.state==='committed')files.push(view(row));}
      const more=rows.length>8,last=selected.at(-1),nextCursor=more?codec.encode({scope,after:[last.message_id,last.id]}):null;
      return{roomId,files,contractVersion:2,coverage:{kind:'selected-messages',messageIds:ids,complete:!more,examined:selected.length},page:{hasMore:more,nextCursor}};
    }));
  }
  list(token, roomId, options={}) {
    if(isCurrentRoom(this.db,roomId))return this.listCurrent(token,roomId,options);
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      this.expire(roomId, this.store.now());
      const messages = this.messageIndex(roomId);
      const memberId = auth.member.id;
      const files = this.db.prepare(`SELECT ${FILE_METADATA} FROM room_attachments
        WHERE room_id=? AND state IN ('staged','committed')
        ORDER BY created_at DESC, id`).all(roomId)
        .filter(row => this.visibleTo(row, messages, memberId))
        .map(view);
      return { roomId, files };
    });
  }

  get(token, roomId, id) {
    return this.store.transaction(() => withCurrentReadContext(this.db,roomId,() => {
      const auth = this.store.authenticate(token, roomId);
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      const current=isCurrentRoom(this.db,roomId),selected=new Map();
      // Only this attachment's bound message, within this authenticated TX.
      // Repeated visibility checks must not hydrate the same payload twice.
      const messages=current?{get:messageId=>{
        if(!selected.has(messageId)){
          if(selected.size)fail(409,'attachment_metadata_unavailable','Attachment binding changed');
          if(!currentMessageMayBeVisible(this.db,roomId,messageId,auth.member.id,undefined,readCurrentHistoryFloor(this.db,roomId,auth.member.id))){
            if(this.db.prepare('SELECT 1 FROM messages WHERE room_id=? AND message_id=?').get(roomId,messageId))fail(404,'attachment_not_found','Attachment not found');
            selected.set(messageId,undefined);return undefined;
          }
          selected.set(messageId,readCurrentMessage(this.db,roomId,messageId)?.value);
        }
        return selected.get(messageId);
      }}:this.messageIndex(roomId);
      if(!current)this.expire(roomId, this.store.now());
      if(current){const scalar=this.db.prepare('SELECT CASE WHEN length(CAST(uploader_id AS BLOB))<=512 THEN uploader_id END uploader_id,CASE WHEN length(CAST(message_id AS BLOB))<=512 THEN message_id END message_id,state,length(CAST(filename AS BLOB))+length(CAST(media_type AS BLOB))+length(CAST(uploader_id AS BLOB))+coalesce(length(CAST(message_id AS BLOB)),0)+length(CAST(sha256 AS BLOB))+128 AS n FROM room_attachments WHERE room_id=? AND id=?').get(roomId,id);if(scalar){if(!this.visibleTo(scalar,messages,auth.member.id))fail(404,'attachment_not_found','Attachment not found');if(!Number.isSafeInteger(scalar.n)||scalar.n>4096)fail(409,'attachment_metadata_unavailable','File metadata requires recovery');}}
      const row = this.db.prepare(`SELECT ${FILE_METADATA},bytes IS NOT NULL AS has_bytes
        FROM room_attachments WHERE room_id=? AND id=?`).get(roomId, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      // Terminal states must preserve the bound message's visibility too:
      // a 410 would reveal a hidden DM attachment's existence.
      if (!this.visibleTo(row, messages, auth.member.id)) {
        fail(404, "attachment_not_found", "Attachment not found");
      }
      // Knowing a file id is not permission to bypass the conversation floor.
      // Bind every current committed/terminal file to its protected message
      // before fetching bytes; an orphan never becomes a room-wide file.
      if(current&&(row.message_id||row.state==='committed')){
        const message=row.message_id?messages.get(row.message_id):undefined;
        const floor=readCurrentHistoryFloor(this.db,roomId,auth.member.id);
        if(!message||!messageInHistory(message,floor))fail(404,'attachment_not_found','Attachment not found');
      }
      if ((row.state !== "staged" && row.state !== "committed") || (row.state==="staged"&&row.expires_at<=this.store.now()) || !row.has_bytes) {
        fail(410, "attachment_unavailable", "Attachment bytes are no longer available");
      }
      const payload = this.db.prepare("SELECT bytes FROM room_attachments WHERE room_id=? AND id=?").get(roomId, id);
      return {
        roomId,
        attachment: { ...view(row), encoding: "base64", data: Buffer.from(payload.bytes).toString("base64") }
      };
    }));
  }

  discard(token, roomId, id) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.authorityState(roomId, auth.member.id), actor: auth.member, action: "room_discard_file", fail });
      // Guests may read and chat but may not store room files. discard()
      // authenticates directly and bypasses store.command, so the RoomStore
      // guest scope gate never runs here — enforce the same denial
      // explicitly. Mirrors RC-2026-09-27-2716 (PR #1156).
      if (isGuestAgentMemberId(auth.member.id))
        fail(403, "guest_scope_denied", "Guest members cannot discard room files");
      if (!validId(id)) fail(422, "invalid_attachment", "Attachment id is not valid");
      const now = this.store.now();
      this.expire(roomId, now);
      const row = this.db.prepare(`SELECT ${FILE_METADATA} FROM room_attachments WHERE room_id=? AND id=?`).get(roomId, id);
      if (!row) fail(404, "attachment_not_found", "Attachment not found");
      const ownerId = this.authorityState(roomId, auth.member.id).room.ownerId;
      const permitted = row.uploader_id === auth.member.id || ownerId === auth.member.id;
      // Committed files never expire, so without a delete path a room whose
      // byte quota fills with committed files can never upload again. The
      // uploader or the room owner deletes a committed file: bytes are
      // dropped and the row moves to the existing terminal 'deleted' state,
      // which no quota counts. Visibility is checked first so the id does
      // not leak a DM file's existence, including a deleted retry receipt.
      // Expired/discarded unbound uploads also retain uploader-only privacy;
      // the owner's staged-file administration grant is checked separately.
      if (row.state !== "staged"
        && !this.visibleTo(row, this.messageIndex(roomId), auth.member.id))
        fail(404, "attachment_not_found", "Attachment not found");
      if (row.state === "deleted") {
        if (!permitted) fail(404, "attachment_not_found", "Attachment not found");
        return { status: "deleted", duplicate: true, roomId, id };
      }
      if (row.state === "committed") {
        if (!permitted) fail(403, "attachment_forbidden", "Only the uploader or the room owner can delete this file");
        const removed = this.write(roomId, () => this.db.prepare(`UPDATE room_attachments SET state='deleted', bytes=NULL
          WHERE room_id=? AND id=? AND state='committed'`).run(roomId, id).changes);
        if (removed !== 1) fail(409, "attachment_conflict", "That attachment changed before it could be deleted");
        return { status: "deleted", duplicate: false, roomId, id };
      }
      if (row.state !== "staged") fail(410, "attachment_unavailable", "Only a staged or committed room file can be discarded");
      if (!permitted) {
        fail(403, "attachment_forbidden", "Only the uploader or the room owner can discard this file");
      }
      const changed = this.write(roomId, () => this.db.prepare(`UPDATE room_attachments SET state='discarded', bytes=NULL
        WHERE room_id=? AND id=? AND state='staged'`).run(roomId, id).changes);
      if (changed !== 1) fail(409, "attachment_conflict", "That attachment changed before it could be discarded");
      return { status: "discarded", roomId, id };
    });
  }

  // Bind a staged file to a chat message the caller already posted.
  // Same id + messageId is a duplicate. A different message does not move it.
  commit(token, roomId, { id, messageId } = {}) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId);
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.authorityState(roomId, auth.member.id), actor: auth.member, action: "room_commit_file", fail });
      // Guests may read and chat but may not store room files. commit()
      // authenticates directly and bypasses store.command, so the RoomStore
      // guest scope gate never runs here — enforce the same denial
      // explicitly. Mirrors RC-2026-09-27-2716 (PR #1156).
      if (isGuestAgentMemberId(auth.member.id))
        fail(403, "guest_scope_denied", "Guest members cannot commit room files");
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
      const message = this.messageIndex(roomId).get(messageId);
      if (!message || message.deletedAt) fail(404, "message_not_found", "Message not found");
      if (message.authorId !== auth.member.id) {
        fail(403, "attachment_forbidden", "Commit a file only onto a message you posted");
      }
      const changed = this.write(roomId, () => this.db.prepare(`UPDATE room_attachments SET state='committed', message_id=?
        WHERE room_id=? AND id=? AND state='staged' AND uploader_id=? AND message_id IS NULL`).run(
        messageId, roomId, id, auth.member.id
      ).changes);
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
