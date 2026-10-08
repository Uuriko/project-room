// Payload store schema (WAVE-300). Content-addressed blob store for room
// payloads; anything over payloadLimits.inlineBytes rides here instead of
// inline in event bodies. Mirrors attachment-schema.mjs owning
// room_attachments. Purely additive: room_attachments is untouched.

export const payloadLimits = Object.freeze({
  inlineBytes: 64 * 1024,            // payloads this size or smaller stay inline in event bodies
  maxBlobBytes: 25 * 1024 * 1024,    // matches attachments.mjs DEFAULTS.maxFileBytes
  orphanLifetimeMs: 24 * 60 * 60 * 1000, // aligns with attachmentLimits.lifetimeMs (24h)
});

export const payloadSchema = `CREATE TABLE IF NOT EXISTS payload_blobs (
  sha256      TEXT PRIMARY KEY CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0 AND byte_length<=${payloadLimits.maxBlobBytes}),
  media_type  TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payload_pins (
  sha256     TEXT NOT NULL REFERENCES payload_blobs(sha256),
  kind       TEXT NOT NULL CHECK(kind IN ('event','claim','attachment')),
  room_id    TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(sha256, kind, room_id, ref_id)
);
CREATE INDEX IF NOT EXISTS payload_pins_sha ON payload_pins(sha256);`;

// Idempotent: CREATE TABLE/INDEX IF NOT EXISTS. New tables only, so there is
// no migration path to maintain — a divergent existing table is an operator
// problem, not something this helper papers over.
export function ensurePayloadSchema(db) {
  db.exec(payloadSchema);
  return "ready";
}
