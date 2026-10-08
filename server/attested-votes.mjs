// Attested-ballot protocol (identity-sybil guild W6): the convention's
// hand-run distinct-identity ballot as a first-class protocol object.
//
// Mechanics (normative detail lives in
// research_notes/swarm-100-2026-10-07/guild-identity-sybil/W6-attestation-protocol.md):
// a vote room pins an admitted-delegate allowlist (or open-with-registration);
// the server issues single-use 5-minute challenge nonces (stored hashed); the
// voter signs canonical ballot bytes
//   { type: "project-room/ballot-v1", voteRoomId, identityId, choice, nonce, challengeId, issuedAt }
// with the mint-issued Ed25519 private key; the server verifies against the
// registered public key whose validity window covers issuedAt. Ballots are
// recorded WITH their proof attached (publicKey + signature), so anyone with
// read access can recount offline — no server trust required for the count.
//
// Double-vote prevention is structural: UNIQUE(vote_room_id, identity_id)
// collapses ten delegates sharing one identity.json to one counted ballot.
//
// What this does NOT claim: N distinct minted identities are still N votes.
// This is double-vote-proof per identity and publicly countable, not
// sybil-proof. "ATTESTED BY X" manual phrases are never machine evidence —
// only Ed25519 signatures over the canonical bytes count.
//
// Endorsement gate: ballots are endorsed-only (IDENTITY-DISCIPLINE-SPEC §7.1).
// The endorsement-tier worker has not landed yet, so isEndorsed() consults
// store.endorsementTiers when present and otherwise allows; the 403
// unendorsed_identity path is wired and tested via the injectable seam.
import { randomBytes, createHash } from "node:crypto";
import { canonicalize, verifySignatureBytes } from "./agent-card-signing.mjs";
import { ServiceError } from "./service-error.mjs";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const ISSUED_AT_SKEW_MS = 5 * 60 * 1000;

const VOTE_ROOM_ID_PATTERN = /^vr_[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MODES = ["allowlist", "open"];
const PROOF_MODES = ["signature", "server", "either"];

// Additive schema. Ends on a real statement (Cloudflare Workers' SQLite
// exec() rejects a trailing comment-only chunk).
export const attestedVoteSchema = `
  CREATE TABLE IF NOT EXISTS vote_rooms (
    vote_room_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    proof_mode TEXT NOT NULL,
    options TEXT NOT NULL,
    opens_at INTEGER,
    closes_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS voter_allowlist (
    vote_room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    PRIMARY KEY (vote_room_id, identity_id)
  );
  CREATE TABLE IF NOT EXISTS voter_registrations (
    vote_room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    registration_proof TEXT NOT NULL,
    PRIMARY KEY (vote_room_id, identity_id)
  );
  CREATE TABLE IF NOT EXISTS vote_challenges (
    challenge_id TEXT PRIMARY KEY,
    vote_room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attested_ballots (
    ballot_id TEXT PRIMARY KEY,
    vote_room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    nonce TEXT,
    challenge_id TEXT,
    issued_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    public_key TEXT,
    signature TEXT,
    proof_mode TEXT NOT NULL,
    UNIQUE (vote_room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS attested_ballots_room ON attested_ballots(vote_room_id);
  CREATE INDEX IF NOT EXISTS vote_challenges_room_identity ON vote_challenges(vote_room_id, identity_id);
  CREATE INDEX IF NOT EXISTS voter_allowlist_room ON voter_allowlist(vote_room_id);
`;

const fail = (status, code, message, detail) => {
  const error = new ServiceError(status, code, message);
  if (detail !== undefined) error.detail = detail;
  throw error;
};

const idOf = prefix => `${prefix}_${randomBytes(12).toString("hex")}`;
const hashNonce = nonce => createHash("sha256").update(nonce).digest("hex");

// The exact bytes a ballot signature covers. Binding all of voteRoomId,
// identityId, nonce and challengeId defeats cross-room replay and ballot
// transplanting; issuedAt is skew-bounded server-side. Exported so any
// reader can re-verify a ballot offline (the recount path).
export function canonicalBallotBytes({ voteRoomId, identityId, choice, nonce, challengeId, issuedAt }) {
  if (typeof voteRoomId !== "string" || typeof identityId !== "string"
    || typeof nonce !== "string" || typeof challengeId !== "string") {
    throw new ServiceError(422, "invalid_ballot", "Ballot fields must be strings");
  }
  if (!Number.isInteger(issuedAt)) throw new ServiceError(422, "invalid_ballot", "issuedAt must be an integer ms epoch");
  const payload = { type: "project-room/ballot-v1", voteRoomId, identityId, choice, nonce, challengeId, issuedAt };
  return Buffer.from(JSON.stringify(canonicalize(payload)), "utf8");
}

const freezeRoom = (row, { admittedCount, ballotsCast }) => Object.freeze({
  voteRoomId: row.vote_room_id,
  roomId: row.room_id,
  title: row.title,
  mode: row.mode,
  proofMode: row.proof_mode,
  options: JSON.parse(row.options),
  opensAt: row.opens_at,
  closesAt: row.closes_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  admittedCount,
  ballotsCast,
});

const receiptOf = row => Object.freeze({
  ballotId: row.ballot_id,
  voteRoomId: row.vote_room_id,
  identityId: row.identity_id,
  choice: JSON.parse(row.choice),
  nonce: row.nonce,
  challengeId: row.challenge_id,
  issuedAt: row.issued_at,
  recordedAt: row.recorded_at,
  publicKey: row.public_key,
  signature: row.signature,
  proofMode: row.proof_mode,
});

export class AttestedVotes {
  // Constructed by RoomStore next to AgentKeyRegistry; the schema is
  // installed by the writer boot path (purely additive, outside the writer
  // fence — see unfencedAdditiveTables), not by the constructor.
  constructor(store) { this.store = store; this.db = store.db; }

  // Endorsement gate (IDENTITY-DISCIPLINE-SPEC §7.1: ballots are
  // endorsed-only). The endorsement-tier worker has not landed yet, so this
  // consults store.endorsementTiers when a future slice provides it and
  // otherwise treats admitted identities as endorsed. Overridable per
  // instance (tests pin it); the 403 unendorsed_identity path below is live.
  isEndorsed(roomId, identityId) {
    const tiers = this.store.endorsementTiers;
    if (tiers && typeof tiers.isEndorsed === "function") return tiers.isEndorsed(roomId, identityId);
    return true;
  }

  now() { return typeof this.store.now === "function" ? this.store.now() : Date.now(); }

  createVoteRoom({ roomId, title, mode = "allowlist", identityIds = [], options = [],
                   opensAt = null, closesAt = null, proofMode = "signature", createdBy = null } = {}) {
    if (typeof roomId !== "string" || roomId.length === 0) fail(422, "invalid_vote_room", "roomId is required");
    if (typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
      fail(422, "invalid_vote_room", "title must be a non-empty string up to 200 chars");
    }
    if (!MODES.includes(mode)) fail(422, "invalid_vote_room", `mode must be one of ${MODES.join("|")}`);
    if (!PROOF_MODES.includes(proofMode)) fail(422, "invalid_vote_room", `proofMode must be one of ${PROOF_MODES.join("|")}`);
    if (!Array.isArray(options) || options.length < 2) fail(422, "invalid_vote_room", "options needs at least two {id,label} entries");
    const seen = new Set();
    for (const option of options) {
      if (option === null || typeof option !== "object" || typeof option.id !== "string" || option.id.length === 0
        || typeof option.label !== "string" || option.label.length === 0 || seen.has(option.id)) {
        fail(422, "invalid_vote_room", "every option needs a unique non-empty string id and label");
      }
      seen.add(option.id);
    }
    const roster = [...new Set(Array.isArray(identityIds) ? identityIds : [])];
    if (mode === "allowlist") {
      if (roster.length === 0) fail(422, "invalid_vote_room", "allowlist mode needs a non-empty identityIds roster");
      for (const id of roster) {
        if (typeof id !== "string" || !IDENTITY_ID_PATTERN.test(id)) fail(422, "invalid_vote_room", "identityIds must be valid identity ids");
      }
    }
    for (const stamp of [opensAt, closesAt]) {
      if (stamp !== null && (!Number.isInteger(stamp) || stamp < 0)) fail(422, "invalid_vote_room", "opensAt/closesAt must be integer ms epochs");
    }
    if (opensAt !== null && closesAt !== null && closesAt <= opensAt) {
      fail(422, "invalid_vote_room", "closesAt must be after opensAt");
    }
    if (typeof createdBy !== "string" || createdBy.length === 0) fail(422, "invalid_vote_room", "createdBy is required");
    const voteRoomId = idOf("vr");
    const now = this.now();
    this.store.transaction(() => {
      this.db.prepare(`INSERT INTO vote_rooms(vote_room_id, room_id, title, mode, proof_mode, options,
        opens_at, closes_at, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(voteRoomId, roomId, title.trim(), mode, proofMode, JSON.stringify(options),
          opensAt, closesAt, createdBy, now);
      if (mode === "allowlist") {
        const insert = this.db.prepare("INSERT OR IGNORE INTO voter_allowlist(vote_room_id, identity_id) VALUES(?,?)");
        for (const id of roster) insert.run(voteRoomId, id);
      }
    });
    return this.getVoteRoom(roomId, voteRoomId);
  }

  listVoteRooms(roomId) {
    return this.db.prepare("SELECT * FROM vote_rooms WHERE room_id=? ORDER BY created_at")
      .all(roomId).map(row => this.withCounts(row));
  }

  getVoteRoom(roomId, voteRoomId) {
    if (typeof voteRoomId !== "string" || !VOTE_ROOM_ID_PATTERN.test(voteRoomId)) {
      fail(404, "vote_room_not_found", "No such vote room");
    }
    const row = this.db.prepare("SELECT * FROM vote_rooms WHERE vote_room_id=? AND room_id=?").get(voteRoomId, roomId);
    if (!row) fail(404, "vote_room_not_found", "No such vote room");
    return this.withCounts(row);
  }

  withCounts(row) {
    const admittedCount = row.mode === "allowlist"
      ? this.db.prepare("SELECT COUNT(*) AS n FROM voter_allowlist WHERE vote_room_id=?").get(row.vote_room_id).n
      : this.db.prepare("SELECT COUNT(*) AS n FROM voter_registrations WHERE vote_room_id=?").get(row.vote_room_id).n;
    const ballotsCast = this.db.prepare("SELECT COUNT(*) AS n FROM attested_ballots WHERE vote_room_id=?").get(row.vote_room_id).n;
    return freezeRoom(row, { admittedCount, ballotsCast });
  }

  // Open-mode registration. The caller is identity-authenticated by the
  // route layer (x-identity-secret binds body.identityId); the stored
  // registration_proof records that attestation.
  register({ roomId, voteRoomId, identityId } = {}) {
    const room = this.getVoteRoom(roomId, voteRoomId);
    this.assertValidIdentity(identityId);
    if (room.mode !== "open") fail(403, "registration_closed", "This vote room uses a pinned allowlist; registration is closed");
    this.assertEndorsed(roomId, identityId);
    this.assertWindowOpen(room);
    const existing = this.db.prepare("SELECT 1 FROM voter_registrations WHERE vote_room_id=? AND identity_id=?")
      .get(voteRoomId, identityId);
    if (existing) fail(409, "already_registered", "This identity is already registered in this vote room");
    const now = this.now();
    this.db.prepare("INSERT INTO voter_registrations(vote_room_id, identity_id, registered_at, registration_proof) VALUES(?,?,?,?)")
      .run(voteRoomId, identityId, now, JSON.stringify({ method: "identity-secret", at: now }));
    return Object.freeze({ voteRoomId, identityId, registeredAt: now });
  }

  issueChallenge({ roomId, voteRoomId, identityId } = {}) {
    const room = this.getVoteRoom(roomId, voteRoomId);
    this.assertValidIdentity(identityId);
    this.assertEndorsed(roomId, identityId);
    this.assertAdmitted(room, identityId);
    this.assertWindowOpen(room);
    // Signature-capable rooms need a registered key up front so the voter
    // learns about the upgrade path before signing anything.
    if (room.proofMode !== "server") this.assertHasKey(identityId);
    const now = this.now();
    const challengeId = idOf("ch");
    const nonce = randomBytes(16).toString("base64url");
    this.db.prepare(`INSERT INTO vote_challenges(challenge_id, vote_room_id, identity_id, nonce_hash,
      expires_at, consumed_at, created_at) VALUES(?,?,?,?,?,NULL,?)`)
      .run(challengeId, voteRoomId, identityId, hashNonce(nonce), now + CHALLENGE_TTL_MS, now);
    return Object.freeze({ voteRoomId, identityId, nonce, expiresAt: now + CHALLENGE_TTL_MS, challengeId });
  }

  // Cast a ballot. identityId is pre-authenticated by the route layer
  // (x-identity-secret). Returns { receipt, created }: created=false means
  // an idempotent re-submit of the exact same ballot returned the stored
  // receipt instead of recording a duplicate.
  castBallot({ roomId, voteRoomId, identityId, choice, nonce = null, challengeId = null,
               issuedAt = null, signature = null } = {}) {
    const room = this.getVoteRoom(roomId, voteRoomId);
    this.assertValidIdentity(identityId);
    this.assertEndorsed(roomId, identityId);
    this.assertAdmitted(room, identityId);
    this.assertWindowOpen(room);
    this.assertValidChoice(room, choice);
    const now = this.now();
    const at = issuedAt ?? now;
    if (!Number.isInteger(at) || at < 0) fail(422, "invalid_ballot", "issuedAt must be an integer ms epoch");
    if (Math.abs(now - at) > ISSUED_AT_SKEW_MS) fail(422, "stale_ballot", "issuedAt is outside the 5-minute skew bound");

    let proofMode = "server";
    let publicKey = null;
    let storedNonce = null;
    let storedChallengeId = null;
    if (room.proofMode === "signature" || (room.proofMode === "either" && signature !== null)) {
      proofMode = "signature";
      if (typeof nonce !== "string" || nonce.length === 0
        || typeof challengeId !== "string" || challengeId.length === 0
        || typeof signature !== "string" || signature.length === 0) {
        fail(422, "invalid_ballot", "signature mode needs nonce, challengeId and signature");
      }
      const challenge = this.db.prepare("SELECT * FROM vote_challenges WHERE challenge_id=?").get(challengeId);
      if (!challenge || challenge.vote_room_id !== voteRoomId || challenge.identity_id !== identityId) {
        fail(410, "challenge_expired", "Unknown challenge for this vote room and identity");
      }
      if (challenge.consumed_at !== null) fail(409, "challenge_reused", "This challenge nonce was already consumed");
      if (challenge.expires_at <= now) fail(410, "challenge_expired", "The challenge nonce TTL has lapsed");
      // Challenge-response binding: the signed nonce must be the nonce the
      // server issued for this challenge. A ballot signed over any other
      // nonce is not an answer to this challenge.
      if (hashNonce(nonce) !== challenge.nonce_hash) {
        fail(422, "bad_signature", "The ballot nonce does not match the issued challenge");
      }
      const key = this.store.keyRegistry.keyForIdentityAt(identityId, at);
      if (!key) {
        fail(409, "no_identity_key", "This identity has no registered Ed25519 key covering issuedAt", {
          upgrade: `POST /api/agent-identities/${identityId}/keys/rotate`,
          how: "generate an Ed25519 keypair locally; POST { newPublicKey } with your pri_ identity secret as bearer",
        });
      }
      const bytes = canonicalBallotBytes({ voteRoomId, identityId, choice, nonce, challengeId, issuedAt: at });
      if (!verifySignatureBytes({ publicKey: key.publicKey, signature, bytes })) {
        fail(422, "bad_signature", "Ed25519 verification failed against the identity's registered key");
      }
      publicKey = key.publicKey;
      storedNonce = nonce;
      storedChallengeId = challengeId;
    } else if (room.proofMode === "server" || room.proofMode === "either") {
      if (signature !== null || nonce !== null || challengeId !== null) {
        fail(422, "invalid_ballot", "server mode ballots carry no signature fields");
      }
    } else {
      fail(422, "invalid_ballot", "Unknown proof mode");
    }

    const ballotId = idOf("b");
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM attested_ballots WHERE vote_room_id=? AND identity_id=?")
        .get(voteRoomId, identityId);
      if (existing) {
        // Idempotent re-submit of the exact same ballot returns the stored
        // receipt; anything else from the same identity is a double vote.
        if (proofMode === "signature" && existing.challenge_id === storedChallengeId && existing.signature === signature) {
          return { receipt: receiptOf(existing), created: false };
        }
        fail(409, "ballot_duplicate", "This identity has already cast a ballot in this vote room");
      }
      try {
        this.db.prepare(`INSERT INTO attested_ballots(ballot_id, vote_room_id, identity_id, choice, nonce,
          challenge_id, issued_at, recorded_at, public_key, signature, proof_mode)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
          .run(ballotId, voteRoomId, identityId, JSON.stringify(choice), storedNonce, storedChallengeId,
            at, now, publicKey, signature, proofMode);
      } catch (error) {
        // Race backstop: the UNIQUE(vote_room_id, identity_id) constraint is
        // the real double-vote guard; the pre-check above is the friendly path.
        if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") fail(409, "ballot_duplicate", "This identity has already cast a ballot in this vote room");
        throw error;
      }
      if (proofMode === "signature") {
        const consumed = this.db.prepare("UPDATE vote_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL")
          .run(now, storedChallengeId);
        if (consumed.changes === 0) fail(409, "challenge_reused", "This challenge nonce was already consumed");
      }
      return { receipt: receiptOf(this.db.prepare("SELECT * FROM attested_ballots WHERE ballot_id=?").get(ballotId)), created: true };
    });
  }

  listBallots(roomId, voteRoomId) {
    this.getVoteRoom(roomId, voteRoomId);
    return this.db.prepare("SELECT * FROM attested_ballots WHERE vote_room_id=? ORDER BY recorded_at")
      .all(voteRoomId).map(receiptOf);
  }

  tally(roomId, voteRoomId) {
    const room = this.getVoteRoom(roomId, voteRoomId);
    const rows = this.db.prepare("SELECT choice, COUNT(*) AS n FROM attested_ballots WHERE vote_room_id=? GROUP BY choice")
      .all(voteRoomId);
    const tally = {};
    for (const row of rows) {
      const choice = JSON.parse(row.choice);
      const key = Array.isArray(choice) ? choice.join(">") : String(choice);
      tally[key] = row.n;
    }
    const ballotsCast = this.db.prepare("SELECT COUNT(*) AS n FROM attested_ballots WHERE vote_room_id=?").get(voteRoomId).n;
    return Object.freeze({ voteRoomId, tally, ballotsCast,
      admittedCount: room.admittedCount, duplicates: this.findDuplicates(voteRoomId) });
  }

  // The §2.3 duplicate-detection query: returns zero rows in a healthy
  // election. Anyone with read access can run the recount.
  findDuplicates(voteRoomId) {
    return this.db.prepare(`SELECT vote_room_id AS voteRoomId, identity_id AS identityId, COUNT(*) AS n
        FROM attested_ballots WHERE vote_room_id=? GROUP BY vote_room_id, identity_id HAVING n > 1`)
      .all(voteRoomId).map(row => Object.freeze({ ...row }));
  }

  assertValidIdentity(identityId) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) {
      fail(422, "invalid_ballot", "identityId must be a valid agent identity id");
    }
  }

  assertEndorsed(roomId, identityId) {
    if (!this.isEndorsed(roomId, identityId)) {
      fail(403, "unendorsed_identity", "This identity is not endorsed in this room; ballots are endorsed-only");
    }
  }

  assertAdmitted(room, identityId) {
    const admitted = room.mode === "allowlist"
      ? this.db.prepare("SELECT 1 FROM voter_allowlist WHERE vote_room_id=? AND identity_id=?").get(room.voteRoomId, identityId)
      : this.db.prepare("SELECT 1 FROM voter_registrations WHERE vote_room_id=? AND identity_id=?").get(room.voteRoomId, identityId);
    if (!admitted) fail(403, "not_admitted", "This identity is not on the admitted-delegate list for this vote room");
  }

  assertWindowOpen(room) {
    const now = this.now();
    if (room.opensAt !== null && now < room.opensAt) fail(409, "vote_closed", "This vote room has not opened yet");
    if (room.closesAt !== null && now > room.closesAt) fail(409, "vote_closed", "This vote room has closed");
  }

  assertValidChoice(room, choice) {
    const ids = new Set(room.options.map(option => option.id));
    const picks = Array.isArray(choice) ? choice : [choice];
    if (picks.length === 0 || !picks.every(pick => typeof pick === "string" && ids.has(pick))) {
      fail(422, "invalid_ballot", "choice must be an option id (or ranked list of option ids) from this vote room");
    }
  }

  assertHasKey(identityId) {
    const key = this.store.keyRegistry.keyForIdentityAt(identityId, this.now());
    if (!key) {
      fail(409, "no_identity_key", "This identity has no registered Ed25519 key (legacy identity)", {
        upgrade: `POST /api/agent-identities/${identityId}/keys/rotate`,
        how: "generate an Ed25519 keypair locally; POST { newPublicKey } with your pri_ identity secret as bearer",
      });
    }
    return key;
  }
}

export { verifySignatureBytes };
