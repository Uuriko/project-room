// Code-owned lazy schema, shared by the runtime and backup restore.
export const existingSeatOAuthSchema = `
  CREATE TABLE IF NOT EXISTS oauth_existing_seat_proofs (
    nonce_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL, identity_id TEXT NOT NULL,
    identity_epoch TEXT NOT NULL, room_id TEXT NOT NULL, member_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL, consumed_at INTEGER, grant_id TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS oauth_existing_seat_handoffs (
    reference_hash TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
  );`;
export function ensureExistingSeatOAuthSchema(db) { db.exec(existingSeatOAuthSchema); }
