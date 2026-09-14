// One-time agent invite codes: the self-serve half of the plug-in loop.
//
// An owner mints a short single-use code bound to a room with an explicit
// agent permission scope and an expiry. Any agent redeems the code without
// an owner round-trip: redemption mints a fresh agent identity, links it
// into the room as an agent member with exactly the code's permissions, and
// burns the code. Redeeming never creates an account session and can never
// grant manage_members/decide — rejected at issuance, and re-checked by the
// member.added event validator for kind:"agent".
//
// The code itself is the bearer credential, so only a hash of it is stored:
// a deterministic scrypt (so lookup by hash still works, and no deployment
// secret is needed) that costs orders of magnitude more per guess than a
// bare sha256. Codes minted before the v2 format (8 symbols, sha256 stored)
// keep redeeming until they expire. Audit is the table: created_by/at,
// expires_at, redeemed_at/by, revoked_at, all queryable through list().

import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { applyEvent, event, EVENT_TYPES as T, memberCan, MEMBERSHIP_AUTHORITY_POLICY_VERSION, PERMISSIONS } from "../src/events.js";
import { agentAccessProfiles } from "./agent-connections.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = text => createHash("sha256").update(text).digest("hex");
// Mirrors the projection compaction in store.mjs: strip replay-only caches.
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

const CODE_PREFIX = "RM-";
// v2 codes: 16 symbols from a 32-symbol alphabet = 80 bits of entropy.
// Crockford base32 (no I/L/O/U); redeem() folds the confusable I/L -> 1 and
// O -> 0 so a transcribed code still works.
const CODE_LENGTH = 16;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// v1 codes (pre-v2 rows, sha256 stored): 8 symbols from a 31-symbol alphabet.
const LEGACY_CODE_LENGTH = 8;
const LEGACY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = new RegExp(`^${CODE_PREFIX}(?:[${CODE_ALPHABET}]{${CODE_LENGTH}}|[${LEGACY_CODE_ALPHABET}]{${LEGACY_CODE_LENGTH}})$`);
const CODE_HASH_SALT = "project-room-agent-invite-v2";
const CODE_HASH_PARAMS = { N: 16384, r: 8, p: 1 };

// Uniform symbols without modulo bias: a byte is used only when it falls in
// the largest multiple of the alphabet size, otherwise it is rejected and a
// fresh byte drawn. (For a 32-symbol alphabet nothing is ever rejected; the
// guard keeps the sampler correct if the alphabet changes.)
const randomSymbols = (length, alphabet) => {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length - out.length)) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
};
// Deterministic slow hash for v2 codes. Legacy 8-symbol codes were stored as
// bare sha256, so lookup dispatches on the code format.
const codeHash = code => code.length === CODE_PREFIX.length + LEGACY_CODE_LENGTH
  ? hash(code)
  : scryptSync(code, CODE_HASH_SALT, 32, CODE_HASH_PARAMS).toString("hex");
const NEVER_GRANT = ["manage_members", "decide"];
const DEFAULT_TTL_MINUTES = 1440; // 24h
const MIN_TTL_MINUTES = 5;
const MAX_TTL_MINUTES = 43200; // 30d
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Public handle for a stored code: the first 8 hex digits (32 bits) of the
// stored hash. Enough to pick one row within a room; too short to confirm a
// guessed legacy 8-symbol code offline (about 2^40 candidates map onto 2^32
// handles), so the full hash never leaves the server.
const INVITE_ID_LENGTH = 8;
const INVITE_ID_PATTERN = /^[a-f0-9]{8}$/;
const inviteId = storedHash => storedHash.slice(0, INVITE_ID_LENGTH);

export const agentInviteSchema = `
  CREATE TABLE IF NOT EXISTS agent_invite_codes (
    code_hash TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    created_by TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER,
    redeemed_identity_id TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_invite_codes_room ON agent_invite_codes(room_id);
`;

const inviteStatus = (row, now) =>
  row.revoked_at != null ? "revoked"
  : row.redeemed_at != null ? "redeemed"
  : now >= row.expires_at ? "expired" : "active";

const view = (row, now) => ({
  inviteId: inviteId(row.code_hash),
  roomId: row.room_id,
  createdBy: row.created_by,
  permissions: JSON.parse(row.permissions_json),
  displayName: row.display_name,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  redeemedAt: row.redeemed_at,
  redeemedIdentityId: row.redeemed_identity_id,
  revokedAt: row.revoked_at,
  status: inviteStatus(row, now),
});

export class AgentInvites {
  constructor(store) { this.store = store; this.db = store.db; }

  // Owner-only: mint a one-time code. The raw code is returned once; only
  // its hash is stored. Callers may pass an explicit permissions list or a
  // standing profile name (chat/contribute/review); the profile maps
  // server-side to a fixed set, so editing the request cannot widen authority.
  create(token, roomId, { permissions, profile, expiresInMinutes = DEFAULT_TTL_MINUTES, displayName } = {}, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    let profileName = null;
    if (profile !== undefined) {
      if (typeof profile !== "string" || !Object.hasOwn(agentAccessProfiles, profile))
        fail(422, "invalid_invite_scope", "profile must be one of: chat, contribute, review");
      if (permissions !== undefined)
        fail(422, "invalid_invite_scope", "Choose a profile or explicit permissions, not both");
      profileName = profile;
      permissions = [...agentAccessProfiles[profile]];
    }
    if (!Array.isArray(permissions) || (profileName === null && !permissions.length) || new Set(permissions).size !== permissions.length
      || permissions.some(p => !PERMISSIONS.includes(p))) {
      fail(422, "invalid_invite_scope", "permissions must be a non-empty list of unique room permissions");
    }
    if (permissions.some(p => NEVER_GRANT.includes(p))) {
      fail(422, "invalid_invite_scope", "Agent invite codes cannot grant manage_members or decide");
    }
    // Non-owner issuers cannot delegate authority they do not hold. Mirrors
    // requireScopedMemberAdministration in the member.added event validator.
    const issuer = authority.members[auth.member.id];
    if (!issuer || issuer.active === false) fail(403, "access_denied", "Active membership required");
    if (auth.member.id !== authority.ownerId && permissions.some(p => !issuer.permissions.includes(p))) {
      fail(403, "invite_scope_exceeded", "A membership administrator cannot grant authority they do not hold");
    }
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < MIN_TTL_MINUTES || expiresInMinutes > MAX_TTL_MINUTES) {
      fail(422, "invalid_invite_ttl", `expiresInMinutes must be ${MIN_TTL_MINUTES}-${MAX_TTL_MINUTES}`);
    }
    if (displayName !== undefined && typeof displayName !== "string") fail(422, "invalid_invite", "displayName must be text");
    const name = displayName === undefined ? null : displayName.trim();
    if (name !== null && (!name || name.length > 80)) fail(422, "invalid_invite_name", "displayName must be 1-80 characters");
    // Generate and hash before taking the write lock: scrypt is deliberately slow.
    const code = CODE_PREFIX + randomSymbols(CODE_LENGTH, CODE_ALPHABET);
    const stored = codeHash(code);
    return this.store.transaction(() => {
      const now = this.store.now();
      const expiresAt = now + expiresInMinutes * 60000;
      this.db.prepare(`INSERT INTO agent_invite_codes(code_hash,room_id,created_by,permissions_json,display_name,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`).run(stored, roomId, auth.member.id, JSON.stringify(permissions), name, now, expiresAt);
      return { code, inviteId: inviteId(stored), roomId, permissions, profile: profileName, displayName: name, createdAt: now, expiresAt };
    });
  }

  // Unauthenticated: the code is the bearer credential. Burns the code,
  // mints an identity, and links it as an agent member — all atomically.
  redeem(code, { displayName } = {}) {
    // Legacy codes never contain I/L/O, so folding the confusables is safe
    // for both formats.
    const normalized = typeof code === "string" ? code.trim().toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0") : "";
    if (!CODE_PATTERN.test(normalized)) {
      fail(404, "invite_unavailable", "Invite code is invalid, expired, or already used");
    }
    // Hash outside the write transaction: scrypt is deliberately slow.
    const lookup = codeHash(normalized);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM agent_invite_codes WHERE code_hash=?").get(lookup);
      if (!row) fail(404, "invite_unavailable", "Invite code is invalid, expired, or already used");
      if (row.revoked_at != null) fail(410, "invite_revoked", "Invite code was revoked");
      const now = this.store.now();
      if (now >= row.expires_at) fail(410, "invite_expired", "Invite code expired");
      if (row.redeemed_at != null) fail(409, "invite_already_used", "Invite code was already used");
      const room = this.store.room(row.room_id);
      // The inviter's authority is re-checked at redemption, like invitation
      // acceptance: a demoted issuer's outstanding codes stop working.
      const issuer = room.state.members[row.created_by];
      if (!issuer || issuer.active === false || !issuer.permissions.includes("manage_members")) {
        fail(409, "invite_authority_changed", "Inviter authority changed; ask for a new invite code");
      }
      if (room.sequence >= 10000 || Object.keys(room.state.members).length >= 100) {
        fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      }
      const name = typeof displayName === "string" && displayName.trim() ? displayName.trim()
        : row.display_name || "Invited agent";
      if (name.length > 80) fail(422, "invalid_invite_name", "displayName must be 1-80 characters");
      const identity = this.store.identities.create(name);
      const memberId = identity.identityId;
      if (!MEMBER_ID_PATTERN.test(memberId)) fail(500, "invite_failed", "Generated member id is invalid");
      const permissions = JSON.parse(row.permissions_json);
      const incoming = event({
        id: randomUUID(),
        idempotencyKey: hash(`agent-invite-redeem:${row.code_hash}`),
        type: T.MEMBER_ADDED,
        roomId: row.room_id,
        actorId: row.created_by,
        at: new Date(now).toISOString(),
        data: {
          memberId,
          displayName: name,
          kind: "agent",
          permissions,
          identityId: identity.identityId,
          authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
        },
      });
      let state;
      try { state = compactState(applyEvent(room.state, incoming)); }
      catch (error) { fail(409, "invite_rejected", error.message); }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(row.room_id, identity.identityId, memberId, now);
      // Compare-and-swap burn: exactly one redemption wins under concurrency.
      const burned = this.db.prepare(`UPDATE agent_invite_codes SET redeemed_at=?,redeemed_identity_id=?
        WHERE code_hash=? AND redeemed_at IS NULL AND revoked_at IS NULL`).run(now, identity.identityId, row.code_hash);
      if (burned.changes !== 1) fail(409, "invite_already_used", "Invite code was already used");
      // No account session, no member_accounts row: the identity secret is the
      // only credential. The secret is shown once, like identity-create.
      return { identityId: identity.identityId, secret: identity.secret, roomId: row.room_id, memberId, displayName: name, permissions };
    });
  }

  // Owner-only: revoke an unredeemed code by the handle list() and create()
  // return. Already-redeemed members are unaffected; unlink those with
  // identity-unlink.
  revoke(token, roomId, id, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    if (typeof id !== "string" || !INVITE_ID_PATTERN.test(id)) fail(422, "invalid_invite", "inviteId is required");
    return this.store.transaction(() => {
      const rows = this.db.prepare(`SELECT code_hash FROM agent_invite_codes
        WHERE room_id=? AND substr(code_hash,1,?)=? AND redeemed_at IS NULL AND revoked_at IS NULL`).all(roomId, INVITE_ID_LENGTH, id);
      if (!rows.length) fail(404, "invite_unavailable", "Invite code not found, already used, or already revoked");
      if (rows.length > 1) fail(409, "invite_ambiguous", "More than one active invite matches this handle; revoke it from the database");
      this.db.prepare("UPDATE agent_invite_codes SET revoked_at=? WHERE code_hash=?").run(this.store.now(), rows[0].code_hash);
      return { inviteId: id, revoked: true };
    });
  }

  // Owner-only: audit view. Raw codes are never stored and the stored hash
  // stays server-side; rows carry the inviteId handle that revoke() takes.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    const now = this.store.now();
    return this.db.prepare("SELECT * FROM agent_invite_codes WHERE room_id=? ORDER BY created_at DESC").all(roomId)
      .map(row => view(row, now));
  }
}
