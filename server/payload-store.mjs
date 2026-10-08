// Payload store (WAVE-300): content-addressed blob store for room payloads.
//
// Payloads up to payloadLimits.inlineBytes keep riding inline in event
// bodies; anything larger is uploaded once, addressed by its SHA-256, and
// events carry only the hash plus metadata. Global scope gives free
// cross-room dedup.
//
// GC is a pinned-set sweep (not refcount): a blob row is deleted iff it is
// older than payloadLimits.orphanLifetimeMs AND no payload_pins row names
// its sha256. Pins are written transactionally by the caller alongside the
// write that introduces the reference (event append, claim write), so GC
// never deletes a referenced blob.
//
// The store takes a BlobBackend in its constructor (default
// LocalBlobBackend over the payload_blobs table). The async surface is kept
// so an R2 backend can drop in later with no caller changes; this slice
// does no network and stores no credentials.

import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { payloadLimits, ensurePayloadSchema } from "./payload-schema.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// Same media-type policy as server/room-attachment-bytes.mjs (checkedFile):
// type/subtype shape, lowercase, plus the executable/script blocklist.
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

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PIN_KINDS = new Set(["event", "claim", "attachment"]);

export function base64LengthForPayloadBytes(byteLength) {
  return 4 * Math.ceil(byteLength / 3);
}

// Canonical base64 with no whitespace, generalized from
// room-attachment-bytes.mjs validAttachmentData to the 25 MiB payload cap.
export function validPayloadData(value) {
  if (typeof value !== "string" || value.length > base64LengthForPayloadBytes(payloadLimits.maxBlobBytes)) return false;
  if (value.length % 4 !== 0) return false;
  if (value.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return true;
}

function decodePayloadData(value) {
  if (!validPayloadData(value)) fail(422, "invalid_payload", "data must be canonical base64 with no whitespace");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(422, "invalid_payload", "data must be canonical base64 with no whitespace");
  if (bytes.length > payloadLimits.maxBlobBytes) fail(413, "payload_too_large", "Payload exceeds the 25 MiB payload size limit");
  return bytes;
}

// Filenames don't exist on the payload endpoint, so the blocked-extension
// checks have no filename to run against — the MIME-type blocklist is the
// enforcement point (design §8). Returns the normalized lowercase media type.
function checkPayloadMediaType(mediaType) {
  if (typeof mediaType !== "string") fail(422, "invalid_payload", "mediaType must be a string");
  const type = mediaType.toLowerCase();
  if (!MEDIA_TYPE.test(type)) fail(422, "invalid_payload", "mediaType must be a type/subtype media type");
  if (BLOCKED_MEDIA_TYPES.has(type) || type.startsWith("application/x-ms") || type.startsWith("application/x-dos")) {
    fail(422, "blocked_media_type", "That media type is not accepted for a payload");
  }
  return type;
}

function checkSha256(sha256) {
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    fail(422, "invalid_payload_ref", "sha256 must be a 64-char lowercase hex digest");
  }
  return sha256;
}

function checkPin({ sha256, kind, roomId, refId }) {
  checkSha256(sha256);
  if (!PIN_KINDS.has(kind)) fail(422, "invalid_pin", `kind must be one of ${[...PIN_KINDS].join(", ")}`);
  if (typeof roomId !== "string" || roomId.length === 0) fail(422, "invalid_pin", "roomId must be a non-empty string");
  if (typeof refId !== "string" || refId.length === 0) fail(422, "invalid_pin", "refId must be a non-empty string");
}

// BlobBackend interface (R2-ready). LocalBlobBackend below is the SQLite
// implementation used by this slice.
export class BlobBackend {
  async put(sha256, { bytes, mediaType, byteLength, createdAt } = {}) {
    throw new Error(`unimplemented: put ${sha256}`);
  }
  async get(sha256) {
    // -> { bytes, mediaType, byteLength } | null
    throw new Error(`unimplemented: get ${sha256}`);
  }
  async del(sha256) {
    throw new Error(`unimplemented: del ${sha256}`);
  }
  async exists(sha256) {
    throw new Error(`unimplemented: exists ${sha256}`);
  }
}

// SQLite BLOB backend over the payload_blobs table. Synchronous under the
// hood (node:sqlite); the async surface stays so an R2 backend drops in
// later with no caller changes.
export class LocalBlobBackend extends BlobBackend {
  constructor(db) {
    super();
    this.db = db;
  }

  async put(sha256, { bytes, mediaType, byteLength, createdAt } = {}) {
    const now = Number.isInteger(createdAt) ? createdAt : Date.now();
    const info = this.db.prepare(`INSERT OR IGNORE INTO payload_blobs
      (sha256, byte_length, media_type, bytes, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(sha256, byteLength, mediaType, Buffer.from(bytes), now);
    return { duplicate: info.changes === 0 };
  }

  async get(sha256) {
    const row = this.db.prepare(`SELECT sha256, byte_length, media_type, bytes
      FROM payload_blobs WHERE sha256=?`).get(sha256);
    if (!row) return null;
    return { bytes: Buffer.from(row.bytes), mediaType: row.media_type, byteLength: row.byte_length };
  }

  async del(sha256) {
    const info = this.db.prepare("DELETE FROM payload_blobs WHERE sha256=?").run(sha256);
    return info.changes > 0;
  }

  async exists(sha256) {
    return this.db.prepare("SELECT 1 FROM payload_blobs WHERE sha256=?").get(sha256) != null;
  }
}

export class PayloadStore {
  constructor(db, { backend, now } = {}) {
    this.db = db;
    ensurePayloadSchema(db);
    this.backend = backend ?? new LocalBlobBackend(db);
    this.now = typeof now === "function" ? now : () => Date.now();
  }

  // Upload bytes; the server derives the sha256, so dedup and integrity are
  // one step. Idempotent: same bytes -> same sha -> duplicate:true.
  // Upload alone creates NO pin; the blob is an orphan until referenced.
  async put({ mediaType, dataBase64 } = {}) {
    const type = checkPayloadMediaType(mediaType);
    const bytes = decodePayloadData(dataBase64);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { duplicate } = await this.backend.put(sha256, {
      bytes,
      mediaType: type,
      byteLength: bytes.length,
      createdAt: this.now(),
    });
    return { sha256, byte_length: bytes.length, duplicate };
  }

  async get(sha256) {
    checkSha256(sha256);
    const blob = await this.backend.get(sha256);
    if (!blob) fail(404, "payload_not_found", "Payload not found");
    return {
      sha256,
      byte_length: blob.byteLength,
      media_type: blob.mediaType,
      dataBase64: Buffer.from(blob.bytes).toString("base64"),
    };
  }

  // Record that something durable (an event body, a claim record, a future
  // attachment externalization) names this hash. Callers write the pin in
  // the same transaction as the referencing write. INSERT OR IGNORE makes
  // re-pinning the same reference idempotent.
  async pin({ sha256, kind, roomId, refId } = {}) {
    checkPin({ sha256, kind, roomId, refId });
    const info = this.db.prepare(`INSERT OR IGNORE INTO payload_pins
      (sha256, kind, room_id, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(sha256, kind, roomId, refId, this.now());
    return { sha256, kind, roomId, refId, duplicate: info.changes === 0 };
  }

  async unpin({ sha256, kind, roomId, refId } = {}) {
    checkPin({ sha256, kind, roomId, refId });
    const info = this.db.prepare(`DELETE FROM payload_pins
      WHERE sha256=? AND kind=? AND room_id=? AND ref_id=?`).run(sha256, kind, roomId, refId);
    return { removed: info.changes > 0 };
  }

  // Pinned-set sweep. Deletes a blob row iff created_at <= now -
  // orphanLifetimeMs AND no payload_pins row names its sha256, so a
  // referenced blob is never deleted. Candidates are selected with LIMIT
  // for bounded batches, but the DELETE re-checks eligibility in the same
  // statement, so a pin written between the SELECT and the DELETE still
  // protects the blob. Backend del runs per deleted row so a future R2
  // backend stays consistent.
  async gc({ now = this.now(), limit = 1000 } = {}) {
    const cutoff = now - payloadLimits.orphanLifetimeMs;
    const candidates = this.db.prepare(`SELECT sha256, byte_length FROM payload_blobs
      WHERE created_at <= ? AND sha256 NOT IN (SELECT sha256 FROM payload_pins)
      ORDER BY created_at LIMIT ?`).all(cutoff, limit);
    if (candidates.length === 0) return { deleted: 0, bytesFreed: 0 };
    const placeholders = candidates.map(() => "?").join(",");
    const deleted = this.db.prepare(`DELETE FROM payload_blobs
      WHERE sha256 IN (${placeholders})
        AND created_at <= ?
        AND sha256 NOT IN (SELECT sha256 FROM payload_pins)
      RETURNING sha256, byte_length`).all(...candidates.map(row => row.sha256), cutoff);
    let bytesFreed = 0;
    for (const row of deleted) {
      bytesFreed += row.byte_length;
      await this.backend.del(row.sha256);
    }
    return { deleted: deleted.length, bytesFreed };
  }
}
