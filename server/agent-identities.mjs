// Multi-room agent identities (round-2 task #101).
//
// Today an agent working in N rooms is provisioned N times: N member
// records, N access keys. An agent identity is one stable credential an
// agent carries across rooms: the identity is created once, a room owner
// links it into their room (creating one member record bound to the
// identity), and the agent then authenticates to every linked room with
// the same secret. Rooms keep full sovereignty — linking and unlinking
// are owner-only, and unlinking deactivates the room member.

import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { generateKeyPair as generateEd25519KeyPair } from "./agent-card-signing.mjs";
import { memberCan } from "../src/events.js";
import { nextActionsForIdentityMint } from "./discoverability.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const agentIdentitySchema = `
  CREATE TABLE IF NOT EXISTS agent_identities (
    identity_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS identity_links (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    identity_id TEXT NOT NULL REFERENCES agent_identities(identity_id),
    member_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS identity_links_member ON identity_links(room_id, member_id);
`;

// Idempotent additive migration for the revoked_at column (RC-2026-09-19-055:
// identity-secret rotate/revoke). Existing rows backfill NULL, which reads
// as "not revoked". Follows the spam-quarantine column pattern (PR #562):
// called from the writer boot path, not the module constructor (the module
// is constructed before tables exist). agent_identities is excluded from
// the upgrade comparability filter, so the column evolution is audit-safe.
export function ensureIdentitySecretSchema(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_identities'").get();
  if (!exists) return;
  const columns = new Set(db.prepare("PRAGMA table_info(agent_identities)").all().map(column => column.name));
  if (!columns.has("revoked_at")) db.exec("ALTER TABLE agent_identities ADD COLUMN revoked_at INTEGER");
}

// RC-2026-09-24-210: identity-holder proof-of-possession for identityId
// enrollment (Uuriko/project-room#942, replacing the #948 interim disable).
// The identity HOLDER mints a single-use enrollment code with their own
// secret; a sponsor presents it on agent-connections create. Only the
// SHA-256 hash is stored — the raw code is returned once, never logged,
// never persisted. 10-minute TTL, bound to the minting identityId.
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CODE_BYTES = 16; // 128 bits of entropy
export const LINK_CODE_RE = /^[A-Za-z0-9_-]{22}$/; // base64url(16 bytes)
const MAX_OUTSTANDING_LINK_CODES = 10;

export const identityLinkCodeSchema = `
  CREATE TABLE IF NOT EXISTS identity_link_codes (
    code_hash TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES agent_identities(identity_id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS identity_link_codes_identity ON identity_link_codes(identity_id, expires_at);
`;

// Purely additive — IF NOT EXISTS is idempotent, no schema version bump,
// and the table is intentionally outside the writer fence (see
// unfencedAdditiveTables): older writers have no code path to it, rows are
// hash-only, and mint/consume verify their own shape on open.
export function ensureIdentityLinkCodeSchema(db) {
  db.exec(identityLinkCodeSchema);
}

export const IDENTITY_SECRET_PREFIX = "pri_";
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isIdentitySecret(token) {
  return typeof token === "string" && token.startsWith(IDENTITY_SECRET_PREFIX)
    && /^[A-Za-z0-9_-]{43,128}$/.test(token.slice(IDENTITY_SECRET_PREFIX.length));
}

const legacyHash = text => createHash("sha256").update(text).digest("hex");
const base64url = bytes => Buffer.from(bytes).toString("base64url");

// v2 identity-secret hashes (RC-2026-09-23): a deterministic scrypt — lookup
// by hash still works and no deployment secret is needed — that costs orders
// of magnitude more per guess than the legacy bare sha256 (invite v2 pattern:
// deterministic salt, no random per-row salt). Stored with a "v2:" prefix so
// legacy rows (bare 64-hex sha256) are distinguishable. Legacy hashes are
// upgraded to v2 on the next successful verification (upgrade-on-login), so
// no mass rehash and no secret rotation is required.
const IDENTITY_HASH_SALT = "project-room-agent-identity-v2";
const IDENTITY_HASH_PARAMS = { N: 16384, r: 8, p: 1 };
const IDENTITY_HASH_PREFIX = "v2:";
const v2Hash = secret => `${IDENTITY_HASH_PREFIX}${scryptSync(secret, IDENTITY_HASH_SALT, 32, IDENTITY_HASH_PARAMS).toString("hex")}`;
// Stored-format hash for a newly issued secret.
const hashIdentitySecret = secret => v2Hash(secret);
// Every stored-format candidate for a presented secret: v2 first, legacy
// second for upgrade-on-login.
const hashCandidates = secret => [v2Hash(secret), legacyHash(secret)];
const isV2Hash = stored => typeof stored === "string" && stored.startsWith(IDENTITY_HASH_PREFIX);

// Identity creation is unauthenticated (an identity alone grants nothing),
// so the table is bounded like the credentials table in store.mjs: a hard
// cap checked inside the insert transaction, not just a per-IP rate limit.
export const IDENTITY_LIMIT = 5000;

// Machine-readable next steps for a brand-new agent. The signup response
// is the first thing a cold agent sees: instead of returning a secret with
// no direction, it names the concrete first actions (create your own room,
// join via invite, request access, read the manifest/quickstart). All of
// them are self-serve or unauthenticated; nothing here needs a human tap.
const SIGNUP_NEXT = Object.freeze([
  Object.freeze({ action: "create-room", method: "POST", path: "/api/agent-rooms",
    description: "Create your own room and become its owner — no human approval needed. Send this identity secret as the bearer token." }),
  Object.freeze({ action: "redeem-invite", method: "POST", path: "/api/agent-invites/redeem",
    description: "Join a room with a one-time invite code. Ask any room member who can invite for a code, or check /api/agent-invites/preview." }),
  Object.freeze({ action: "request-access", method: "POST", path: "/api/access-requests",
    description: "Ask to join a room without an invite code. The room owner decides; poll the request status." }),
  Object.freeze({ action: "read-manifest", method: "GET", path: "/api/agent-manifest",
    description: "The agent plug-in manifest: auth schemes, enrollment flows, API-key scopes, and the agent surface." }),
  Object.freeze({ action: "read-quickstart", doc: "docs/AGENT-QUICKSTART.md",
    description: "Ten-minute quickstart: presence, work sessions, messaging, handoffs, and the rules of the road." }),
  // Burs-IA steal A1: the mint response names the tools-list surface so a
  // cold agent learns its capabilities without reading llms.txt.
  Object.freeze({ action: "list-tools", method: "POST", path: "/room/mcp",
    description: "See what this identity can do: POST { jsonrpc: \"2.0\", id: \"1\", method: \"tools/list\" } to /room/mcp with Authorization: Bearer <secret>. Without a credential it lists the four public join tools; with it, the enrolled room profile." }),
]);

export class AgentIdentities {
  constructor(store, { identityLimit = IDENTITY_LIMIT } = {}) { this.store = store; this.db = store.db; this.identityLimit = identityLimit; }

  // Creates a new global agent identity. The secret is shown once and only
  // its hash is stored. An identity alone grants nothing: a room owner must
  // link it into each room. The response carries SIGNUP_NEXT so a cold
  // agent knows its first moves without asking a human.
  create(displayName, { secret: suppliedSecret } = {}) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 80) fail(422, "invalid_identity", "displayName must be 1-80 characters");
    // RC-2026-09-19-086: reject C0 control chars like share-link join does
    // (422 there) — storing them raw corrupts logs, exports, and renders.
    if (/[\u0000-\u001f\u007f]/.test(name)) fail(422, "invalid_identity", "displayName must not contain control characters");
    if (suppliedSecret !== undefined && !/^pri_[A-Za-z0-9_-]{43}$/.test(suppliedSecret))
      fail(422, "invalid_identity", "Recoverable registration requires a generated identity credential");
    return this.store.transaction(() => {
      const recoveredId = suppliedSecret === undefined ? null : `ai_${legacyHash(suppliedSecret).slice(0, 40)}`;
      if (recoveredId) {
        const existing = this.db.prepare("SELECT * FROM agent_identities WHERE identity_id=?").get(recoveredId);
        if (existing) {
          const [v2, legacy] = hashCandidates(suppliedSecret);
          if (existing.revoked_at !== null || (existing.secret_hash !== v2 && existing.secret_hash !== legacy))
            fail(409, "identity_credential_changed", "Identity credential changed; use the current saved identity");
          // Upgrade-on-login: a legacy-hash row verified here is rehashed
          // to v2 before returning, so the next verification is v2-only.
          if (!isV2Hash(existing.secret_hash)) {
            this.db.prepare("UPDATE agent_identities SET secret_hash=? WHERE identity_id=? AND secret_hash=?")
              .run(v2, recoveredId, existing.secret_hash);
          }
          return { identityId: recoveredId, displayName: existing.display_name, duplicate: true,
            next: SIGNUP_NEXT, nextActions: nextActionsForIdentityMint() };
        }
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
      if (count >= this.identityLimit) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const now = this.store.now();
      const identityId = recoveredId ?? `ai_${base64url(randomBytes(12))}`;
      const secret = suppliedSecret ?? `${IDENTITY_SECRET_PREFIX}${base64url(randomBytes(32))}`;
      this.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at) VALUES(?,?,?,?)")
        .run(identityId, hashIdentitySecret(secret), name, now);
      // Bind the identity's Ed25519 claim-signing key at issuance: the
      // public key is registered in the agent-key registry (the
      // operator-attested binding — see server/agent-key-registry.mjs) and
      // the private seed is shown once, like the secret. The agent signs
      // public-key claims (signed-claims.mjs ed25519 mode) with it, so
      // cross-room claim verification needs no shared secret.
      const keyPair = generateEd25519KeyPair();
      this.store.keyRegistry.registerKey(identityId, keyPair.publicKey, { validFrom: now });
      return { identityId, displayName: name, ...(recoveredId ? { duplicate: false } : { secret }),
        publicKey: keyPair.publicKey, privateKey: keyPair.privateKey,
        next: SIGNUP_NEXT, nextActions: nextActionsForIdentityMint() };
    });
  }

  get(identityId) {
    return this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName, created_at AS createdAt FROM agent_identities WHERE identity_id=?").get(identityId) ?? null;
  }

  // Owner-only: link an identity into a room, creating one member record
  // bound to it. The agent then uses its single identity secret here.
  // RC-2026-09-18-038: a membership-administration delegate may also link,
  // because decide() drives link() with the approver's token — approving an
  // access request is exactly what the delegation exists for.
  link(token, roomId, { identityId, memberId, displayName, permissions, referredBy, settleAccessRequests = true }, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!this.store.delegation.canAdministerMembership(authority, auth, roomId)) fail(403, "access_denied", "Membership administration grant required");
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(422, "invalid_identity", "identityId is not a valid agent identity");
    const identity = this.get(identityId);
    if (!identity) fail(404, "identity_not_found", "No such agent identity");
    // RC-2026-09-18-049: rooms that require verified agents deny linking an
    // unverified identity. The plug-in store is optional in unit fixtures.
    const plugin = this.store.agentPlugin;
    if (plugin && plugin.roomVerificationPolicy(roomId).requireVerified
      && plugin.verificationLevel(identityId) !== "verified") {
      fail(403, "unverified_identity", "This room only admits verified agents; have a room owner verify the identity first");
    }
    const resolvedMemberId = memberId ?? identityId;
    if (!MEMBER_ID_PATTERN.test(resolvedMemberId)) fail(422, "invalid_identity", "memberId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    if (!Array.isArray(permissions)) fail(422, "invalid_identity", "permissions must be an array; an empty array links the identity with read/chat access only");
    // RC-2026-09-18-038: a delegate acting on an owner grant may link members
    // but may never confer manage_members — that would make the grant
    // transitive. The owner (or a member already holding manage_members)
    // remains sovereign.
    if (permissions.includes("manage_members") && !this.store.delegation.mayConferManageMembers(authority, auth)) {
      fail(403, "access_denied", "Delegated membership administration cannot grant manage_members");
    }
    if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 80)) fail(422, "invalid_identity", "displayName must be text of at most 80 characters");
    // Referral attribution: optional member id of the referrer, written onto
    // the new member record and journaled via referral.completed. Shape is
    // validated here; the member.added event validator re-validates it.
    if (referredBy !== undefined && (typeof referredBy !== "string" || !MEMBER_ID_PATTERN.test(referredBy))) {
      fail(422, "invalid_identity", "referredBy must be a member id");
    }
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (existing) fail(409, "identity_already_linked", "This identity is already linked to this room");
      const roomMember = this.store.roomAuthority(roomId).members[resolvedMemberId];
      if (roomMember) {
        // Re-linking after an unlink: the member record (bound to this
        // identity) is reused and reactivated. A foreign member holding the
        // id is a conflict.
        if (roomMember.identityId !== identityId) fail(409, "identity_conflict", "Member id is already taken");
        // The permissions the owner supplies now win; the stale record's
        // grants must not come back silently.
        const samePermissions = JSON.stringify([...roomMember.permissions].sort()) === JSON.stringify([...permissions].sort());
        if (roomMember.active === false || !samePermissions) {
          this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: resolvedMemberId, expectedMemberRevision: roomMember.revision, permissions, active: true } }, expectedSessionBinding);
        }
        this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
          .run(roomId, identityId, resolvedMemberId, this.store.now());
        if (settleAccessRequests) this.closePendingAccessRequests(roomId, identityId, auth.member.id);
        return { roomId, identityId, memberId: resolvedMemberId, relinked: true };
      }
      this.store.command(token, roomId, { id: randomUUID(), type: "member.added",
        data: { memberId: resolvedMemberId, displayName: displayName?.trim() || identity.displayName, kind: "agent", permissions, identityId,
          ...(referredBy ? { referredBy } : {}) } }, expectedSessionBinding);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identityId, resolvedMemberId, this.store.now());
      if (settleAccessRequests) this.closePendingAccessRequests(roomId, identityId, auth.member.id);
      return { roomId, identityId, memberId: resolvedMemberId };
    });
  }

  // A direct grant used to leave the identity's pending join request in the
  // owner queue. Close those rows when this link is the grant. Callers that
  // record their own decision (access-request approve) pass
  // settleAccessRequests: false. Fixtures without the access-request table
  // are unchanged.
  closePendingAccessRequests(roomId, identityId, decidedBy) {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_requests'").get();
    if (!table) return 0;
    return this.db.prepare(
      `UPDATE access_requests SET status='approved', decided_at=?, decided_by=?, decision_note=?
       WHERE room_id=? AND identity_id=? AND status='pending'`
    ).run(this.store.now(), decidedBy, "closed because this identity was linked directly", roomId, identityId).changes;
  }

  // Owner-only: unlink an identity; the room member is deactivated but its
  // history stays in the event log.
  unlink(token, roomId, identityId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.store.transaction(() => {
      const link = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (!link) fail(404, "identity_not_found", "This identity is not linked to this room");
      const member = this.store.roomAuthority(roomId).members[link.memberId];
      if (member?.active !== false) {
        this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
          data: { memberId: link.memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false } }, expectedSessionBinding);
      }
      this.db.prepare("DELETE FROM identity_links WHERE room_id=? AND identity_id=?").run(roomId, identityId);
      return { roomId, identityId, memberId: link.memberId, unlinked: true };
    });
  }

  // Upgrade-on-login: after a legacy-hash row verifies, rehash it to v2.
  // Conditional on the exact legacy value just verified, so a concurrent
  // rotate/revoke that lands first wins and is never clobbered.
  upgradeLegacyHash(identityId, secret) {
    // Legacy credentials remain valid on read-only paths. Defer this
    // opportunistic migration until a later write-capable authentication;
    // no success on a read requires changing persisted authentication state.
    if (this.store.readOnly || this.store.readTransactionDepth > 0) return;
    const [v2, legacy] = hashCandidates(secret);
    this.db.prepare("UPDATE agent_identities SET secret_hash=? WHERE identity_id=? AND secret_hash=?")
      .run(v2, identityId, legacy);
  }

  // Proves ownership of an identity secret: the presented secret must be
  // the identity's CURRENT, unrevoked secret. Used by rotate/revoke; a
  // revoked secret fails here, so revoke is final — there is no other
  // owner credential for a self-minted identity.
  authenticateIdentitySecret(identityId, secret) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(401, "unauthenticated", "Unknown agent identity");
    if (!isIdentitySecret(secret)) fail(401, "unauthenticated", "Unknown agent identity");
    const [v2, legacy] = hashCandidates(secret);
    const row = this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName, secret_hash AS secretHash FROM agent_identities WHERE identity_id=? AND secret_hash IN (?, ?) AND revoked_at IS NULL")
      .get(identityId, v2, legacy);
    if (!row) fail(401, "unauthenticated", "Unknown or revoked agent identity secret");
    if (!isV2Hash(row.secretHash)) this.upgradeLegacyHash(identityId, secret);
    return { identityId: row.identityId, displayName: row.displayName };
  }

  // Owner-only: rotate an identity secret. The old secret stops working
  // atomically with the issue of the new one; the new secret is returned
  // once (shown once, like the scoped-key rotation in RC-2026-09-18-050).
  // The old secret never appears in any response. Rotating a revoked
  // identity is rejected — revoke is the final state.
  rotate(identityId, secret) {
    const identity = this.authenticateIdentitySecret(identityId, secret);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT revoked_at AS revokedAt, secret_hash AS secretHash FROM agent_identities WHERE identity_id=?").get(identityId);
      if (!row) fail(404, "identity_not_found", "No such agent identity");
      if (row.revokedAt !== null) fail(409, "identity_revoked", "This identity's secret is revoked; it cannot rotate");
      const newSecret = `${IDENTITY_SECRET_PREFIX}${base64url(randomBytes(32))}`;
      // Conditional update on the CURRENT stored hash (authenticate above
      // already upgraded a legacy row to v2): a concurrent revoke/rotate
      // that lands first must win — the stale rotation is rejected instead
      // of resurrecting a revoked secret or double-issuing.
      const changed = this.db.prepare("UPDATE agent_identities SET secret_hash=?, revoked_at=NULL WHERE identity_id=? AND revoked_at IS NULL AND secret_hash=?")
        .run(hashIdentitySecret(newSecret), identityId, row.secretHash);
      if (changed.changes !== 1) fail(409, "secret_changed", "The secret changed during rotation; re-read state and retry");
      return { identityId, displayName: identity.displayName, secret: newSecret, rotatedAt: this.store.now() };
    });
  }

  // Owner-only: revoke an identity secret. The secret stops authenticating
  // everywhere immediately (resolveGlobalIdentitySecret and
  // resolveIdentityAuth both refuse revoked rows); the identity row stays
  // for audit, and room links stay untouched — unlinking remains a separate
  // owner-only per-room action. Revoke is final: there is no other owner
  // credential, so a revoked identity can never rotate back to life.
  // Scoped API keys bound to the identity are revoked too — a revoked
  // identity must not keep operating through a key it minted earlier.
  revoke(identityId, secret) {
    const identity = this.authenticateIdentitySecret(identityId, secret);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?").get(identityId);
      if (!row) fail(404, "identity_not_found", "No such agent identity");
      const revokedAt = row.revokedAt ?? this.store.now();
      if (row.revokedAt === null) {
        this.db.prepare("UPDATE agent_identities SET revoked_at=? WHERE identity_id=?").run(revokedAt, identityId);
      }
      const revokedApiKeys = this.store.agentPlugin ? this.store.agentPlugin.revokeApiKeysForIdentity(identityId) : 0;
      return { identityId, displayName: identity.displayName, revoked: true, revokedAt, revokedApiKeys };
    });
  }

  // Whether an identity's secret is revoked. Read surface only.
  secretRevoked(identityId) {
    const row = this.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?").get(identityId);
    return row ? row.revokedAt !== null : null;
  }

  // RC-2026-09-24-210: mint a single-use identity link code.
  //
  // The caller proves possession of the identity's CURRENT, unrevoked
  // secret — the mint IS the holder's consent to enroll this identity
  // (no separate consent step; a sponsor's credential or scoped API key
  // can never mint). The raw code is returned once; only its SHA-256 hash
  // is stored, bound to the identityId, with a 10-minute TTL. Unknown
  // identityIds 404 (no secret can ever authenticate for them, so the
  // check order leaks nothing).
  mintLinkCode(identityId, secret) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)
      || !this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=?").get(identityId)) {
      fail(404, "identity_not_found", "No such agent identity");
    }
    const identity = this.authenticateIdentitySecret(identityId, secret);
    return this.store.transaction(() => {
      const now = this.store.now();
      // Sweep expired rows on every mint: consumed rows die with their TTL,
      // so the table stays bounded without a background job.
      this.db.prepare("DELETE FROM identity_link_codes WHERE expires_at <= ?").run(now);
      const outstanding = this.db.prepare(
        "SELECT count(*) AS n FROM identity_link_codes WHERE identity_id=? AND consumed_at IS NULL").get(identityId).n;
      if (outstanding >= MAX_OUTSTANDING_LINK_CODES) {
        fail(429, "too_many_link_codes", "Too many outstanding link codes; use one or let it expire");
      }
      const code = base64url(randomBytes(LINK_CODE_BYTES));
      this.db.prepare("INSERT INTO identity_link_codes(code_hash,identity_id,created_at,expires_at,consumed_at) VALUES(?,?,?,?,NULL)")
        .run(legacyHash(code), identityId, now, now + LINK_CODE_TTL_MS);
      return { identityId: identity.identityId, displayName: identity.displayName,
        linkCode: code, expiresAt: now + LINK_CODE_TTL_MS };
    });
  }

  // RC-2026-09-24-210: verify a presented link code and consume it
  // atomically (single-use). Called inside the enrolling transaction, so a
  // create that fails later never burns a code it didn't use.
  //
  // Every failure reads as 422 identity_link_proof_required — the checks
  // (exists, bound to the claimed identityId, unexpired, unused, identity
  // not revoked) share one code so there is no oracle for which of them
  // failed. The raw code is never logged or persisted by the caller.
  consumeLinkCode(identityId, code) {
    if (typeof code !== "string" || !LINK_CODE_RE.test(code)) {
      fail(422, "identity_link_proof_required",
        "Present an identity link code minted by the identity holder (POST /api/identities/{identityId}/link-code)");
    }
    const now = this.store.now();
    const row = this.db.prepare(
      "SELECT identity_id AS identityId, expires_at AS expiresAt, consumed_at AS consumedAt FROM identity_link_codes WHERE code_hash=?")
      .get(legacyHash(code));
    const proofFailed = () => fail(422, "identity_link_proof_required",
      "Present an identity link code minted by the identity holder (POST /api/identities/{identityId}/link-code)");
    if (!row || row.identityId !== identityId || row.expiresAt <= now || row.consumedAt !== null) proofFailed();
    // A code minted before a revocation dies with the identity: revocation
    // stops the secret authenticating everywhere, and its delegations with it.
    const live = this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=? AND revoked_at IS NULL").get(identityId);
    if (!live) proofFailed();
    // Conditional consume: a concurrent consume that lands first wins —
    // single-use is enforced by the row, not by the check above.
    const changed = this.db.prepare("UPDATE identity_link_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL")
      .run(now, legacyHash(code));
    if (changed.changes !== 1) proofFailed();
    return { identityId, consumedAt: now };
  }
  // Owner-only, like the sibling audit lists (agent-invites, agent-connections,
  // share-links): which identities are plugged into a room is membership
  // administration data, not something every member should enumerate.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.db.prepare(`SELECT l.identity_id AS identityId, l.member_id AS memberId, l.linked_at AS linkedAt,
        i.display_name AS identityDisplayName FROM identity_links l
        JOIN agent_identities i ON i.identity_id=l.identity_id WHERE l.room_id=? ORDER BY l.linked_at`).all(roomId);
  }

  // Resolves an identity secret globally, without a room: used by the
  // self-serve agent-room creation path, where no room link exists yet.
  // Returns { identityId, displayName } or null. Malformed secrets are
  // null, never an error, so callers cannot distinguish "bad format" from
  // "unknown secret".
  resolveGlobalIdentitySecret(secret) {
    if (!isIdentitySecret(secret)) return null;
    const [v2, legacy] = hashCandidates(secret);
    const row = this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName, secret_hash AS secretHash FROM agent_identities WHERE secret_hash IN (?, ?) AND revoked_at IS NULL")
      .get(v2, legacy);
    if (!row) return null;
    if (!isV2Hash(row.secretHash)) this.upgradeLegacyHash(row.identityId, secret);
    return { identityId: row.identityId, displayName: row.displayName };
  }

  // Resolves an identity secret to the linked room member, or null. Called
  // from RoomStore#authenticate before the room-key path. Revoked secrets
  // never resolve — rotation/revocation take effect on the next request,
  // with no cache in between (resolution is a fresh DB read every call).
  resolveIdentityAuth(secret, roomId) {
    if (!roomId) return null;
    const [v2, legacy] = hashCandidates(secret);
    const row = this.db.prepare("SELECT identity_id, secret_hash AS secretHash FROM agent_identities WHERE secret_hash IN (?, ?) AND revoked_at IS NULL").get(v2, legacy);
    if (!row) return null;
    if (!isV2Hash(row.secretHash)) this.upgradeLegacyHash(row.identity_id, secret);
    return this.resolveIdentityLink(row.identity_id, roomId);
  }

  // Resolves a known identityId to its linked room member, or null. Used by
  // the API-key auth branch (RC-2026-09-18-012): a verified rak_ key yields
  // an identityId, not a secret, so the link lookup runs by identityId.
  resolveIdentityLink(identityId, roomId) {
    if (!roomId || typeof identityId !== "string" || !identityId) return null;
    const link = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
    if (!link) return null;
    const member = this.store.roomAuthority(roomId).members[link.member_id];
    if (!member || member.active === false) return null;
    return { identityId, member };
  }

  // Lists all rooms where an identity is linked as an active member.
  // Used by the agent browser sign-in flow: after verifying the identity
  // secret, the agent picks which room to open. Returns [{ roomId, title,
  // memberId }] for active links only.
  roomsForIdentity(identityId) {
    if (typeof identityId !== "string" || !identityId) return [];
    const rows = this.db.prepare(`
      SELECT l.room_id AS roomId, l.member_id AS memberId
      FROM identity_links l
      WHERE l.identity_id = ?
      ORDER BY l.linked_at DESC
    `).all(identityId);
    // Filter to active members only, and get room titles from projection
    return rows.filter(row => {
      try {
        const member = this.store.roomAuthority(row.roomId).members[row.memberId];
        if (!member || member.active === false) return false;
        // Get title from room projection
        const roomRow = this.db.prepare("SELECT projection FROM rooms WHERE id=?").get(row.roomId);
        if (roomRow) {
          const proj = JSON.parse(roomRow.projection);
          row.title = proj?.room?.title || row.roomId;
        } else {
          row.title = row.roomId;
        }
        return true;
      } catch {
        return false;
      }
    });
  }
}

