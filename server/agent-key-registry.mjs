// Agent public-key registry (integration map slice 9).
//
// What this is: a room-local directory mapping agent identity -> Ed25519
// public key, with validity windows and rotation overlap. It answers
// signed-claims.mjs's "key distribution is a later slice": an agent signs
// claims with its identity key (the ed25519 mode of signed-claims.mjs) and
// any verifier checks the signature against the registered key whose
// validity window covers the claim's issuedAt. Keys are bound at identity
// issuance (see AgentIdentities#create) and move through
// register -> rotate -> revoke; the table is append-only — rows are never
// deleted or rewritten, only closed (valid_until) or revoked (revoked_at),
// so past claims stay checkable against history.
//
// What this is NOT: this is operator-attested plumbing, not trustlessness.
// Bindings are attested by the room operator (a key is issued with the
// identity card, and rotation/revocation are authorized by the identity's
// own secret). Nothing here is decentralized, nothing touches a blockchain,
// and there is no ERC-8004 or other on-chain dependency. Verifiers trust
// the room that registered the key.
import { generateKeyPair as generateEd25519KeyPair, isValidPublicKey } from "./agent-card-signing.mjs";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const agentKeyRegistrySchema = `
  CREATE TABLE IF NOT EXISTS agent_key_registry (
    identity_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER,
    revoked_at INTEGER,
    superseded_by TEXT,
    registered_at INTEGER NOT NULL,
    PRIMARY KEY (identity_id, public_key)
  );
  CREATE INDEX IF NOT EXISTS agent_key_registry_identity ON agent_key_registry(identity_id, valid_from);
`;

// Rotation overlap defaults: a rotated key stays valid long enough for
// in-flight claims to verify, then its window closes. Zero overlap is
// allowed (the old key closes immediately) but claims it signed earlier
// still verify, because verification binds issuedAt — not verify-time — to
// the window.
export const KEY_ROTATION_OVERLAP_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const KEY_ROTATION_OVERLAP_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const freezeEntry = row => Object.freeze({
  identityId: row.identity_id,
  publicKey: row.public_key,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  revokedAt: row.revoked_at,
  supersededBy: row.superseded_by,
});

export class AgentKeyRegistry {
  // Constructed by RoomStore next to AgentIdentities; the schema is
  // installed by the writer boot path (purely additive, outside the
  // writer fence — see unfencedAdditiveTables), not by the constructor.
  constructor(store) { this.store = store; this.db = store.db; }

  // Registers a public key for an identity. Called inside the caller's
  // transaction (AgentIdentities#create binds the issuance key this way).
  // validUntil null = open-ended until rotated or revoked.
  registerKey(identityId, publicKey, { validFrom, validUntil = null } = {}) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(422, "invalid_identity", "identityId is not a valid agent identity");
    if (!isValidPublicKey(publicKey)) fail(422, "invalid_key", "publicKey must be a valid Ed25519 public key");
    const from = validFrom ?? this.store.now();
    if (!Number.isInteger(from) || from < 0) fail(422, "invalid_key", "validFrom must be a non-negative integer timestamp");
    if (validUntil !== null && (!Number.isInteger(validUntil) || validUntil <= from)) fail(422, "invalid_key", "validUntil must be null or an integer after validFrom");
    const identity = this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=?").get(identityId);
    if (!identity) fail(404, "identity_not_found", "No such agent identity");
    // Pre-check, not an INSERT-catch: the PRIMARY KEY is the integrity
    // backstop, but the 409 reads off a named code instead of a driver error.
    const existing = this.db.prepare("SELECT 1 FROM agent_key_registry WHERE identity_id=? AND public_key=?").get(identityId, publicKey);
    if (existing) fail(409, "key_already_registered", "This public key is already registered for the identity");
    const now = this.store.now();
    this.db.prepare("INSERT INTO agent_key_registry(identity_id,public_key,valid_from,valid_until,revoked_at,superseded_by,registered_at) VALUES(?,?,?,?,NULL,NULL,?)")
      .run(identityId, publicKey, from, validUntil, now);
    return freezeEntry({ identity_id: identityId, public_key: publicKey, valid_from: from,
      valid_until: validUntil, revoked_at: null, superseded_by: null });
  }

  // Rotates an identity's key: the new key becomes valid now, and every
  // currently-active key keeps verifying for overlapMs more (rotation
  // overlap) so in-flight claims do not break at the cutover. Authorized by
  // the identity's own secret — the same ownership proof as identity-secret
  // rotation. Rotating a revoked identity is rejected.
  rotateKey(identityId, { identitySecret, newPublicKey, overlapMs = KEY_ROTATION_OVERLAP_DEFAULT_MS } = {}) {
    this.store.identities.authenticateIdentitySecret(identityId, identitySecret);
    if (!isValidPublicKey(newPublicKey)) fail(422, "invalid_key", "newPublicKey must be a valid Ed25519 public key");
    if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs > KEY_ROTATION_OVERLAP_MAX_MS) fail(422, "invalid_key", "overlapMs must be an integer between 0 and 30 days");
    return this.store.transaction(() => {
      const now = this.store.now();
      const dupe = this.db.prepare("SELECT 1 FROM agent_key_registry WHERE identity_id=? AND public_key=?").get(identityId, newPublicKey);
      if (dupe) fail(409, "key_already_registered", "This public key is already registered for the identity");
      const active = this.db.prepare("SELECT public_key, valid_until FROM agent_key_registry WHERE identity_id=? AND valid_from<=? AND (valid_until IS NULL OR valid_until>?) AND revoked_at IS NULL")
        .all(identityId, now, now);
      const closeAt = now + overlapMs;
      let closed = 0;
      for (const row of active) {
        // A key already expiring sooner keeps its earlier window; the new
        // key supersedes the generation that is still open past the cutover.
        if (row.valid_until === null || row.valid_until > closeAt) {
          this.db.prepare("UPDATE agent_key_registry SET valid_until=?, superseded_by=? WHERE identity_id=? AND public_key=?")
            .run(closeAt, newPublicKey, identityId, row.public_key);
          closed += 1;
        }
      }
      this.db.prepare("INSERT INTO agent_key_registry(identity_id,public_key,valid_from,valid_until,revoked_at,superseded_by,registered_at) VALUES(?,?,?,NULL,NULL,NULL,?)")
        .run(identityId, newPublicKey, now, now);
      return Object.freeze({ identityId, publicKey: newPublicKey, validFrom: now, validUntil: null,
        overlapMs, closedKeys: closed });
    });
  }

  // Revokes one registered key. Claims issued before revokedAt still
  // verify (their issuedAt predates the revocation); claims issued at or
  // after revokedAt do not. Authorized by the identity's own secret.
  // Revoking an already-revoked key is a no-op returning its record.
  revokeKey(identityId, { identitySecret, publicKey } = {}) {
    this.store.identities.authenticateIdentitySecret(identityId, identitySecret);
    if (!isValidPublicKey(publicKey)) fail(422, "invalid_key", "publicKey must be a valid Ed25519 public key");
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM agent_key_registry WHERE identity_id=? AND public_key=?").get(identityId, publicKey);
      if (!row) fail(404, "key_not_found", "No such registered key for this identity");
      if (row.revoked_at !== null) return freezeEntry(row);
      const now = this.store.now();
      this.db.prepare("UPDATE agent_key_registry SET revoked_at=? WHERE identity_id=? AND public_key=?").run(now, identityId, publicKey);
      return freezeEntry({ ...row, revoked_at: now });
    });
  }

  // The directory read surface: every key row ever registered for the
  // identity, oldest first. Append-only — revocation and rotation only add
  // lifecycle metadata, so history is never rewritten.
  keysFor(identityId) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) return [];
    return this.db.prepare("SELECT * FROM agent_key_registry WHERE identity_id=? ORDER BY valid_from, registered_at")
      .all(identityId).map(freezeEntry);
  }
}

export { generateEd25519KeyPair };
