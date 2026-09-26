// Guest invites (GX-…): the public-handoff redemption flow for external agents.
//
// v1 (RC-2026-09-23-100, approved by John 2026-09-23). Extends the live
// ga1. guest-agent tier (server/guest-agent-links.mjs) with a safe way to
// invite an agent met in public: the owner mints a single-use invite code
// that reveals nothing and grants nothing by itself; the ga1. credential is
// issued only at redemption, after the guest declares a verifiable agent
// identity (ai_… + Ed25519-signed agent card, server/agent-card-signing.mjs).
//
// The ga1. token is never posted publicly. Storage is purely additive
// (guest_invites + guest_members tables, IF NOT EXISTS, no schema version
// bump), following the wake-queue / heartbeat additive pattern.
import { refuseArchivedWrite } from "./room-lifecycle.mjs";
import { createHash, randomBytes } from "node:crypto";
import { EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION, event, validId } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { verifyCardSignature, isValidPublicKey } from "./agent-card-signing.mjs";
import { createRateLimiter } from "./identity-ratelimit.mjs";
import {
  GUEST_AGENT_TOKEN_PREFIX,
  GUEST_AGENT_TOKEN_PATTERN,
  GUEST_AGENT_MAX_JOINS,
  guestAgentMemberId,
  isGuestAgentMemberId,
} from "./guest-agent-links.mjs";

class GuestInviteError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GuestInviteError(status, code, message); };
const hash = value => createHash("sha256").update(value).digest("hex");

// Invite codes are public-safe: single-use, stored as a hash, and they
// grant nothing by themselves. The credential (ga1.) is issued at redeem.
export const GUEST_INVITE_CODE_PREFIX = "GX-";
export const GUEST_INVITE_CODE_PATTERN = /^GX-[A-Za-z0-9_-]{32}$/;
export const GUEST_INVITE_HASH_PATH = "#agent-join/";
export const GUEST_BADGE_SUFFIX = " (guest)";

// Scope vocabulary. Deliberately narrower than the member profiles
// (chat/contribute/review/collaborate). A guest can never hold a scope
// outside guest:*; the per-request gate in RoomStore#command refuses any
// non-guest command type outright (dual-check with this issuance table).
export const GUEST_INVITE_TIERS = Object.freeze({
  observer: Object.freeze(["guest:read", "guest:post"]),
  contributor: Object.freeze(["guest:read", "guest:post", "guest:draft"]),
});

export const GUEST_CREDENTIAL_TTL_DEFAULT_MS = 72 * 60 * 60 * 1000;
export const GUEST_CREDENTIAL_TTL_MIN_MS = 60 * 60 * 1000;
export const GUEST_CREDENTIAL_TTL_MAX_MS = 14 * 24 * 60 * 60 * 1000;
// Self-serve (RC-2026-09-25-912): no owner mints anything, so the pass is
// short on purpose — 24h, renewable, ejectable. The card signature must be
// fresh (10 min) so a captured request cannot be replayed later.
export const GUEST_SELF_SERVE_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_SELF_SERVE_FRESHNESS_MS = 10 * 60 * 1000;
export const GUEST_SELF_SERVE_SKEW_MS = 2 * 60 * 1000;
// Historical accumulation cap (RC-2026-09-25-912 resolutions): a room may
// hold at most this many self-serve guest seats; when a new guest would
// exceed it, the least-recently-active seat is evicted to make room.
export const GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM = 500;
export const GUEST_INVITE_REDEEM_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const GUEST_INVITE_REDEEM_MIN_MS = 60 * 60 * 1000;
export const GUEST_INVITE_REDEEM_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Concurrent external guests per room. The existing ga1. ceiling
// (GUEST_AGENT_MAX_JOINS = 10) stays as the absolute member cap.
export const GUEST_INVITE_MAX_ACTIVE_PER_ROOM = 5;
const GUEST_ACCESS_TEXT = "Read the room and its history, post messages, and react. Drafts only with the contributor tier. No work lifecycle, invites, polls, or administration.";

const RESERVED_GUEST_NAMES = ["guest", "guest agent", "owner", "room owner", "admin", "administrator", "system", "moderator"];

export const guestInviteSchema = `
  CREATE TABLE IF NOT EXISTS guest_invites (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    tier TEXT NOT NULL CHECK(tier IN ('observer','contributor')),
    credential_ttl_ms INTEGER NOT NULL CHECK(credential_ttl_ms BETWEEN ${GUEST_CREDENTIAL_TTL_MIN_MS} AND ${GUEST_CREDENTIAL_TTL_MAX_MS}),
    guest_label TEXT NOT NULL,
    minted_by_member_id TEXT NOT NULL,
    minted_by_account_id TEXT,
    issue_request_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    redeem_by INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','redeemed','revoked','expired')),
    redeemed_at INTEGER,
    redeemed_by_identity_id TEXT,
    redeemed_member_id TEXT,
    revoked_at INTEGER,
    revoked_by_member_id TEXT,
    CHECK(redeem_by > created_at)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS guest_invite_issue_request ON guest_invites(room_id, minted_by_member_id, issue_request_id);
  CREATE INDEX IF NOT EXISTS guest_invite_room_status ON guest_invites(room_id, status);
  CREATE TABLE IF NOT EXISTS guest_members (
    member_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    guest_identity_id TEXT NOT NULL,
    tier TEXT NOT NULL CHECK(tier IN ('observer','contributor')),
    invite_id TEXT NOT NULL REFERENCES guest_invites(id),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS guest_members_identity_seat ON guest_members(room_id, guest_identity_id);
`;

// Self-serve seats + request-ID idempotency records (RC-2026-09-25-912
// resolutions). Kept as a SEPARATE schema string from guestInviteSchema so a
// database from the v1 window (v1 tables present, these absent) still
// verifies under allowAbsent — each schema string is all-or-nothing, the
// wakeQueue.verifyPauseSchema pattern. Purely additive side tables (no
// events, no projection impact).
//
// Tradeoff, stated plainly: guest_selfserve_idem holds the issued token in
// plaintext so an identical retry can return the original credential. The
// room SQLite store is operator-local; at most one record lives per
// (room, key) — a new requestId supersedes (and deletes) the old record,
// and evicted seats take their records with them.
export const guestSelfServeSchema = `
  CREATE TABLE IF NOT EXISTS guest_selfserve (
    member_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS guest_selfserve_room_active ON guest_selfserve(room_id, last_active_at);
  CREATE TABLE IF NOT EXISTS guest_selfserve_idem (
    room_id TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
    request_id TEXT NOT NULL,
    token TEXT NOT NULL,
    member_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    renewed INTEGER NOT NULL CHECK(renewed IN (0,1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, key_hash, request_id)
  );
`;

function verifySchemaText(db, schemaText, label) {
  return ({ allowAbsent = false } = {}) => {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = schemaText.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error(`${label} schema requires operator reconciliation`);
    }
    return true;
  };
}

export function isGuestInviteCode(value) {
  return typeof value === "string" && GUEST_INVITE_CODE_PATTERN.test(value);
}

// Poll/governance rule (product): guest members are never counted in
// tallies. The decision register is pure and its UI wiring is a later
// slice; this predicate is the single choke point every tally path must
// consult. Guests see polls (guest:read) but their votes do not count.
export function guestVoteExcluded(memberId) {
  return isGuestAgentMemberId(memberId);
}

export function guestInviteContract() {
  return {
    status: "live",
    mint: "owner_only",
    tiers: {
      observer: [...GUEST_INVITE_TIERS.observer],
      contributor: [...GUEST_INVITE_TIERS.contributor],
    },
    credentialTtlMs: {
      default: GUEST_CREDENTIAL_TTL_DEFAULT_MS,
      min: GUEST_CREDENTIAL_TTL_MIN_MS,
      max: GUEST_CREDENTIAL_TTL_MAX_MS,
    },
    redeemWindowMs: {
      default: GUEST_INVITE_REDEEM_DEFAULT_MS,
      min: GUEST_INVITE_REDEEM_MIN_MS,
      max: GUEST_INVITE_REDEEM_MAX_MS,
    },
    maxActiveGuestsPerRoom: GUEST_INVITE_MAX_ACTIVE_PER_ROOM,
    invitePrefix: GUEST_INVITE_CODE_PREFIX,
    hashPath: GUEST_INVITE_HASH_PATH,
    badge: GUEST_BADGE_SUFFIX,
    access: GUEST_ACCESS_TEXT,
    account: false,
  };
}

const newInviteCode = () => GUEST_INVITE_CODE_PREFIX + randomBytes(24).toString("base64url");
const newGuestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");

function assertCardShape(card) {
  if (!card || Array.isArray(card) || typeof card !== "object") fail(422, "card_invalid", "Supply a signed agent card");
  const { name, description, capabilities, publicKey, signature, url, skills, version } = card;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(422, "card_invalid", "The signed card must carry a short display name");
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    fail(422, "card_invalid", "The signed card description is too long");
  }
  if (!Array.isArray(capabilities) || capabilities.length > 32
    || capabilities.some(c => typeof c !== "string" || !c.trim() || c.length > 64)) {
    fail(422, "card_invalid", "The signed card must list capabilities as short strings");
  }
  if (typeof publicKey !== "string" || typeof signature !== "string") {
    fail(422, "card_invalid", "The signed card must carry a publicKey and signature");
  }
  return {
    card: {
      name: name.trim(), description, capabilities,
      ...(url === undefined ? {} : { url }),
      ...(skills === undefined ? {} : { skills }),
      ...(version === undefined ? {} : { version }),
    },
    publicKey,
    signature,
  };
}

export class GuestInvites {
  constructor(store, { selfServeIpLimiter, selfServeKeyLimiter } = {}) {
    this.store = store; this.db = store.db;
    // Self-serve abuse gates: 5 requests/hour per IP, 3/day per card key.
    // Injected for tests; the production defaults are process-local, the
    // same trade server/http.mjs makes for its own rate families.
    this.selfServeIpLimiter = selfServeIpLimiter ?? createRateLimiter({ capacity: 5, refillPerSecond: 5 / 3600, maxKeys: 4000 });
    this.selfServeKeyLimiter = selfServeKeyLimiter ?? createRateLimiter({ capacity: 3, refillPerSecond: 3 / 86400, maxKeys: 4000 });
  }

  verifySchema(opts) {
    return verifySchemaText(this.db, guestInviteSchema, "Guest invite")(opts);
  }

  verifySelfServeSchema(opts) {
    return verifySchemaText(this.db, guestSelfServeSchema, "Guest self-serve")(opts);
  }

  // Owner-only gate. v1 keeps the human owner as the single trust anchor;
  // delegating mint to lanes is a later decision, not a code gap.
  ownerGate(token, roomId, binding) {
    const auth = this.store.guestAgentLinks.owner(token, roomId, binding);
    if (!auth.account) fail(403, "account_session_required", "Minting a guest invite requires a signed-in account session");
    return auth;
  }

  inviteRow(codeHash) {
    return this.db.prepare("SELECT * FROM guest_invites WHERE code_hash=?").get(codeHash);
  }

  liveInvite(row) {
    return row && row.status === "active" && row.redeem_by > this.store.now();
  }

  // One active seat per identity per room: faces are cheap, seats are not.
  seatOf(roomId, identityId) {
    return this.db.prepare("SELECT * FROM guest_members WHERE room_id=? AND guest_identity_id=?").get(roomId, identityId);
  }

  activeGuestCount(roomId) {
    const members = this.store.room(roomId).state.members;
    let n = 0;
    for (const row of this.db.prepare("SELECT member_id FROM guest_members WHERE room_id=?").all(roomId)) {
      const member = members[row.member_id];
      if (member && member.kind === "agent" && member.active !== false && isGuestAgentMemberId(member.id)) n++;
    }
    return n;
  }

  guestTierOf(memberId) {
    // Per-request scope lookup for the RoomStore#command gate. Legacy ga1.
    // members (owner-minted before GX invites) have no row and default to
    // the most restrictive tier: observer. Deactivated members resolve to
    // null — authenticate() already refuses their tokens, and this keeps
    // the predicate honest for audits.
    const row = this.db.prepare("SELECT room_id,tier FROM guest_members WHERE member_id=?").get(memberId);
    if (!row) return null;
    const member = this.store.room(row.room_id).state.members[memberId];
    if (!member || member.active === false) return null;
    return row.tier;
  }

  // Journaled guest-seat deactivation shared by the expiry sweep and the LRU
  // accumulation-cap eviction: builds the MEMBER_ACCESS_CHANGED event
  // directly (the self-serve redemption pattern) with the sponsoring owner
  // as actor, replicating store.command's deactivating side effects
  // (connection revocation, credential revocation, reminder retirement) so
  // every deactivation flavor leaves the same wake. Returns the refreshed
  // room ({ sequence, state }).
  deactivateGuestSeat(roomId, room, actorMemberId, member, eventId) {
    const incoming = event({
      id: eventId, idempotencyKey: eventId, roomId, actorId: actorMemberId,
      type: T.MEMBER_ACCESS_CHANGED, at: new Date(this.store.now()).toISOString(),
      data: {
        memberId: member.id,
        expectedMemberRevision: member.revision,
        permissions: member.permissions,
        active: false,
        authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
      },
    });
    let state;
    try {
      state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
    } catch (error) { fail(422, "command_rejected", error.message); }
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
    this.store.agentConnections.revokeMember(roomId, member.id);
    this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, member.id);
    this.store.reminders.retireMember(roomId, member.id);
    const projection = JSON.stringify(state);
    if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room storage limit reached");
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
    return { sequence, state };
  }

  // Self-serve expiry sweep for the redemption path, where no owner token
  // exists. Mirrors GuestAgentLinks#sweepExpired member-for-member but builds
  // the journal events directly (the redeem MEMBER_ADDED pattern) with the
  // sponsoring owner as actor, replicating store.command's deactivating
  // MEMBER_ACCESS_CHANGED side effects (connection revocation, credential
  // revocation, reminder retirement) so both sweep flavors leave the same
  // wake. Returns the refreshed room ({ sequence, state }).
  sweepExpiredGuests(roomId, room, actorMemberId) {
    for (const member of Object.values(room.state.members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== "agent" || member.active === false) continue;
      const cred = this.db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access'")
        .get(roomId, member.id);
      if (cred && cred.revoked === 0 && cred.expires_at > this.store.now()) continue;
      const eventId = `guest-agent-end-${hash(`${member.id}:${cred?.hash || "none"}`).slice(0, 40)}`;
      room = this.deactivateGuestSeat(roomId, room, actorMemberId, member, eventId);
    }
    return room;
  }

  // LRU accumulation-cap eviction (RC-2026-09-25-912): when a room already
  // holds GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM self-serve seats, the
  // least-recently-active seat is evicted to make room for the newcomer —
  // deactivated (journaled, owner as actor), credentials revoked, seat and
  // idempotency records dropped. Returns the refreshed room.
  evictLruSelfServeSeat(roomId, room, ownerId, now) {
    const victim = this.db.prepare(
      "SELECT member_id FROM guest_selfserve WHERE room_id=? ORDER BY last_active_at ASC, created_at ASC LIMIT 1"
    ).get(roomId);
    if (!victim) fail(429, "rate_limited", "This room is at its guest seat limit; ask the owner to disconnect a guest");
    const member = room.state.members[victim.member_id];
    if (member && member.kind === "agent" && member.active !== false && isGuestAgentMemberId(member.id)) {
      const eventId = `guest-selfserve-evict-${hash(`${member.id}:${now}`).slice(0, 40)}`;
      room = this.deactivateGuestSeat(roomId, room, ownerId, member, eventId);
    }
    this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, victim.member_id);
    this.db.prepare("DELETE FROM guest_selfserve_idem WHERE member_id=?").run(victim.member_id);
    this.db.prepare("DELETE FROM guest_selfserve WHERE member_id=?").run(victim.member_id);
    return room;
  }

  // Seat bookkeeping for the LRU accumulation cap. Upsert: seats created
  // before this table existed gain their row on next use.
  touchSelfServeSeat(roomId, memberId, keyHash, now) {
    this.db.prepare(`INSERT INTO guest_selfserve(member_id, room_id, key_hash, created_at, last_active_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(member_id) DO UPDATE SET last_active_at=excluded.last_active_at`)
      .run(memberId, roomId, keyHash, now, now);
  }

  idemRecord(roomId, keyHash, requestId) {
    return this.db.prepare(
      "SELECT token, member_id, expires_at, renewed FROM guest_selfserve_idem WHERE room_id=? AND key_hash=? AND request_id=?"
    ).get(roomId, keyHash, requestId);
  }

  // Identity-bound seat reactivation for a returning guest whose seat was
  // deactivated (owner disconnect or expiry sweep). Only the identity owning
  // the guest_members row can ever reclaim the seat — the member id is
  // deterministic per identity, so this is a reactivation, never a fresh
  // seat that would leak (or collide with) the old one. The tier stays
  // whatever the owner last set; the display name stays as first minted.
  // Returns the refreshed room ({ sequence, state }).
  reactivateGuestSeat(roomId, room, actorMemberId, inviteId, member) {
    const now = this.store.now();
    const eventId = `guest-invite-reactivate-${hash(`${member.id}:${inviteId}`).slice(0, 40)}`;
    const incoming = event({
      id: eventId, idempotencyKey: eventId, roomId, actorId: actorMemberId,
      type: T.MEMBER_ACCESS_CHANGED, at: new Date(now).toISOString(),
      data: {
        memberId: member.id,
        expectedMemberRevision: member.revision,
        permissions: member.permissions,
        active: true,
        authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
      },
    });
    let state;
    try {
      state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
    } catch (error) { fail(422, "command_rejected", error.message); }
    const projection = JSON.stringify(state), sequence = room.sequence + 1;
    if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room storage limit reached");
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
    // Rebind the seat to the redeeming invite; the tier is owner-set and
    // never escalated by redemption.
    this.db.prepare("UPDATE guest_members SET invite_id=?, created_at=? WHERE member_id=?").run(inviteId, now, member.id);
    return { sequence, state };
  }

  mint(token, roomId, details, binding) {
    if (!details || Array.isArray(details) || typeof details !== "object") fail(422, "invalid_guest_invite", "Supply the guest invite mint fields");
    const allowed = ["requestId", "roomId", "guestLabel", "tier", "credentialTtlMs", "redeemWindowMs", "expectedOwnerRevision"];
    if (Object.keys(details).some(key => !allowed.includes(key))) fail(422, "invalid_guest_invite", "Supply the guest invite mint fields");
    const { requestId, guestLabel, expectedOwnerRevision } = details;
    if (!validId(requestId) || !Number.isSafeInteger(expectedOwnerRevision) || expectedOwnerRevision < 0) {
      fail(422, "invalid_guest_invite", "Supply a requestId and the current owner revision");
    }
    if (details.roomId !== undefined && details.roomId !== roomId) fail(422, "invalid_guest_invite", "Room does not match this mint");
    if (typeof guestLabel !== "string" || !guestLabel.trim() || guestLabel.trim().length > 120) {
      fail(422, "invalid_guest_invite", "Name the guest project so the invite list stays readable");
    }
    const tier = "observer";
    if (details.tier !== undefined && details.tier !== "observer") {
      fail(422, "invalid_guest_invite", "Invites mint at observer; the owner upgrades to contributor explicitly");
    }
    const credentialTtlMs = details.credentialTtlMs ?? GUEST_CREDENTIAL_TTL_DEFAULT_MS;
    if (!Number.isSafeInteger(credentialTtlMs) || credentialTtlMs < GUEST_CREDENTIAL_TTL_MIN_MS || credentialTtlMs > GUEST_CREDENTIAL_TTL_MAX_MS) {
      fail(422, "invalid_guest_invite", "Credential TTL must be between 1 hour and 14 days");
    }
    const redeemWindowMs = details.redeemWindowMs ?? GUEST_INVITE_REDEEM_DEFAULT_MS;
    if (!Number.isSafeInteger(redeemWindowMs) || redeemWindowMs < GUEST_INVITE_REDEEM_MIN_MS || redeemWindowMs > GUEST_INVITE_REDEEM_MAX_MS) {
      fail(422, "invalid_guest_invite", "Redemption window must be between 1 hour and 7 days");
    }
    return this.store.transaction(() => {
      const auth = this.ownerGate(token, roomId, binding);
      if (expectedOwnerRevision !== auth.member.revision) fail(409, "stale_member_revision", "Your room permissions changed; refresh before minting");
      // Expiry rides the existing sweep: any expired guest-agent-* member
      // (ga1. or GX-redeemed) is deactivated here, during owner mint activity.
      this.store.guestAgentLinks.sweepExpired(token, roomId, binding);
      const prior = this.db.prepare("SELECT * FROM guest_invites WHERE room_id=? AND minted_by_member_id=? AND issue_request_id=?")
        .get(roomId, auth.member.id, requestId);
      if (prior) return { ...this.issued(prior, roomId), duplicate: true };
      if (this.db.prepare("SELECT count(*) n FROM guest_invites").get().n >= 5000) fail(409, "pilot_limit", "Invite retention limit reached");
      const code = newInviteCode();
      const now = this.store.now();
      const inviteId = `gx-${hash(`${roomId}:${auth.member.id}:${requestId}`).slice(0, 24)}`;
      this.db.prepare(`INSERT INTO guest_invites(id, code_hash, room_id, tier, credential_ttl_ms, guest_label,
        minted_by_member_id, minted_by_account_id, issue_request_id, created_at, redeem_by, status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?, 'active')`)
        .run(inviteId, hash(code), roomId, tier, credentialTtlMs, guestLabel.trim(),
          auth.member.id, auth.account.id, requestId, now, now + redeemWindowMs);
      const row = this.inviteRow(hash(code));
      return { ...this.issued(row, roomId, code), duplicate: false };
    });
  }

  issued(row, roomId, code) {
    const out = {
      inviteId: row.id,
      roomId,
      tier: row.tier,
      scopes: [...GUEST_INVITE_TIERS[row.tier]],
      credentialTtlMs: row.credential_ttl_ms,
      redeemBy: row.redeem_by,
      guestLabel: row.guest_label,
      hashPath: GUEST_INVITE_HASH_PATH,
      account: false,
    };
    // The code is shown once, at mint. It is public-safe: single-use,
    // stored as a hash, grants nothing by itself.
    if (code !== undefined) out.code = code;
    return out;
  }

  preview(code) {
    if (!isGuestInviteCode(code)) fail(410, "invite_unavailable", "This guest invite is not valid.");
    return this.store.readTransaction(() => {
      const row = this.inviteRow(hash(code));
      if (!this.liveInvite(row)) fail(410, "invite_unavailable", "This guest invite is not valid.");
      const room = this.store.room(row.room_id).state.room;
      return {
        room: { id: room.id, title: room.title },
        kind: "guest-invite",
        tier: row.tier,
        scopes: [...GUEST_INVITE_TIERS[row.tier]],
        access: GUEST_ACCESS_TEXT,
        credentialTtlMs: row.credential_ttl_ms,
        redeemBy: row.redeem_by,
        hashPath: GUEST_INVITE_HASH_PATH,
        account: false,
        consent: "You act as yourself, never as the owner. Your verified agent name is shown with a (guest) badge.",
      };
    });
  }

  redeem(code, identitySecret, cardInput) {
    if (!isGuestInviteCode(code)) fail(410, "invite_unavailable", "This guest invite is not valid.");
    const identity = this.store.identities.resolveGlobalIdentitySecret(identitySecret);
    if (!identity) fail(401, "unauthenticated", "Mint an agent identity first (identity-create needs only the service origin), then redeem.");
    // Verify the signature against the exact card bytes the guest signed —
    // normalization (trimming, field filtering) happens only after the
    // signature checks out, so a legitimately signed card never fails on
    // whitespace or extra fields.
    const rawPublicKey = cardInput?.publicKey, rawSignature = cardInput?.signature;
    const verified = typeof rawPublicKey === "string" && typeof rawSignature === "string"
      && verifyCardSignature({ agentId: identity.identityId, card: cardInput, publicKey: rawPublicKey, signature: rawSignature });
    if (!verified) fail(422, "card_invalid", "The agent card signature does not verify for this identity");
    const { card } = assertCardShape(cardInput);
    return this.store.transaction(() => {
      const row = this.inviteRow(hash(code));
      if (!this.liveInvite(row)) fail(410, "invite_unavailable", "This guest invite is not valid.");
      const roomId = row.room_id;
      let room = this.store.room(roomId);
      refuseArchivedWrite(room.state);
      // Sweep expired guest seats before any capacity decision: an expired
      // membership must not consume the concurrent-guest cap, and the seat
      // logic below must see a consistent state.
      room = this.sweepExpiredGuests(roomId, room, row.minted_by_member_id);
      // One seat per identity per room: faces are cheap, seats are not.
      // The seat check comes before the name check — a returning guest
      // re-redeeming with its own card name must reuse its seat, not
      // collide with itself.
      const seat = this.seatOf(roomId, identity.identityId);
      const existingMember = seat && room.state.members[seat.member_id];
      let memberId;
      let tier = row.tier;
      let duplicate = false;
      if (existingMember && existingMember.active !== false && isGuestAgentMemberId(existingMember.id)) {
        // The same face reuses its member. A new invite upgrades nothing
        // by itself; tier changes stay an explicit owner decision.
        memberId = existingMember.id;
        tier = seat.tier;
        duplicate = true;
      } else if (existingMember && existingMember.kind === "agent" && isGuestAgentMemberId(existingMember.id)) {
        // The same identity's seat was deactivated (owner disconnect or
        // expiry sweep). Reactivate it identity-bound instead of failing
        // seat_taken forever on the deterministic id.
        memberId = existingMember.id;
        tier = seat.tier;
        duplicate = true;
        room = this.reactivateGuestSeat(roomId, room, row.minted_by_member_id, row.id, existingMember);
      } else {
        const name = this.checkedGuestName(room.state, card.name);
        if (this.activeGuestCount(roomId) >= GUEST_INVITE_MAX_ACTIVE_PER_ROOM) {
          fail(429, "rate_limited", "This room is at its concurrent external-guest limit; ask the owner to disconnect a guest");
        }
        // The documented absolute cap was never enforced on this path: a
        // room could accumulate unlimited guest seats over time. Deactivated
        // seats keep their deterministic ids, so they count — this is the
        // absolute member cap, not the concurrent one.
        const guestSeats = Object.values(room.state.members).filter(m => isGuestAgentMemberId(m.id)).length;
        if (guestSeats >= GUEST_AGENT_MAX_JOINS) {
          fail(429, "rate_limited", "This room is at its absolute external-guest seat limit; ask the owner to disconnect a guest");
        }
        memberId = guestAgentMemberId(identity.identityId, roomId);
        if (room.state.members[memberId]) fail(409, "seat_taken", "This identity already holds a guest seat in this room");
        // Self-serve redemption: no owner token is present, so the event is
        // built directly (the joinAgent pattern) with the minting owner as
        // the actor — the journal always shows who sponsored the guest.
        const now = this.store.now();
        const eventId = `guest-invite-${row.id}`;
        const incoming = event({
          id: eventId, idempotencyKey: eventId, roomId, actorId: row.minted_by_member_id,
          type: T.MEMBER_ADDED, at: new Date(now).toISOString(),
          data: {
            memberId,
            displayName: `${name}${GUEST_BADGE_SUFFIX}`,
            kind: "agent",
            permissions: [],
            identityId: identity.identityId,
            accountableHumanId: row.minted_by_member_id,
            authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
          },
        });
        let state;
        try {
          state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
        } catch (error) { fail(422, "command_rejected", error.message); }
        const projection = JSON.stringify(state), sequence = room.sequence + 1;
        if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room storage limit reached");
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
        this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
        this.db.prepare("INSERT INTO guest_members(member_id, room_id, guest_identity_id, tier, invite_id, created_at) VALUES(?,?,?,?,?,?)")
          .run(memberId, roomId, identity.identityId, row.tier, row.id, now);
      }
      // Burn the invite: single-use, bound to the identity that redeemed it.
      this.db.prepare("UPDATE guest_invites SET status='redeemed', redeemed_at=?, redeemed_by_identity_id=?, redeemed_member_id=? WHERE id=? AND status='active'")
        .run(this.store.now(), identity.identityId, memberId, row.id);
      const token = newGuestToken();
      this.store.guestAgentLinks.conflict(hash(token));
      const expiresAt = this.store.now() + row.credential_ttl_ms;
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(token), roomId, memberId, expiresAt);
      const member = this.store.room(roomId).state.members[memberId];
      return {
        token,
        member: { id: member.id, kind: member.kind, permissions: [...member.permissions], displayName: member.displayName, expiresAt },
        room: { id: roomId },
        tier,
        scopes: [...GUEST_INVITE_TIERS[tier]],
        expiresAt,
        hashPath: GUEST_INVITE_HASH_PATH,
        account: false,
        duplicate,
      };
    });
  }

  // Self-serve guest entry (RC-2026-09-25-912): no invite code, no owner in
  // the loop. An outside agent presents a self-signed agent card whose
  // joinRequest binds this exact room + requestId; a valid signature gets a
  // read/chat guest pass automatically.
  //
  // Identity is the card's Ed25519 key, not a pre-registered ai_… identity:
  // member ids derive deterministically from the key, so one key holds one
  // live pass per room, structurally. An identical retry (same requestId)
  // returns the originally issued credential with no rotation and no quota
  // consumed; only a NEW requestId triggers renewal (fresh credential, old
  // one revoked). The owner can disconnect any guest or revoke them all.
  // Guests land at the observer tier (guest:read + guest:post) — the
  // per-request command gate defaults seat-less guest members to observer,
  // so drafts/claims/spending/polls stay out of reach without owner action.
  requestSelfServe(cardInput, clientIp) {
    if (!cardInput || Array.isArray(cardInput) || typeof cardInput !== "object") {
      fail(422, "card_invalid", "Supply a signed agent card with a joinRequest");
    }
    const { agentId, publicKey, signature, joinRequest } = cardInput;
    if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 128) {
      fail(422, "card_invalid", "The agent card must name an agentId");
    }
    if (!isValidPublicKey(publicKey)) {
      fail(422, "card_invalid", "The agent card must carry a valid Ed25519 publicKey");
    }
    if (typeof signature !== "string" || !signature) {
      fail(422, "card_invalid", "The agent card must carry a signature");
    }
    // Cheap per-IP gate before any crypto. The per-key gate runs AFTER
    // signature verification, so a bad signature can't burn someone
    // else's key quota.
    const ipGate = this.selfServeIpLimiter.check(`guest-join:${clientIp || "unknown"}`);
    if (!ipGate.allowed) fail(429, "rate_limited", "Too many guest join requests from this address; try again later");
    const keyHash = hash(publicKey);
    // The joinRequest binds the signature to this room and this request, so
    // a captured card cannot be replayed elsewhere or later.
    if (!joinRequest || Array.isArray(joinRequest) || typeof joinRequest !== "object") {
      fail(422, "card_invalid", "The agent card must carry a joinRequest binding this request");
    }
    const { roomId, requestId, issuedAt } = joinRequest;
    if (typeof roomId !== "string" || !validId(roomId)) fail(422, "card_invalid", "joinRequest.roomId must name a room");
    if (typeof requestId !== "string" || !validId(requestId)) {
      fail(422, "card_invalid", "joinRequest.requestId must be a client-generated idempotency key");
    }
    const now = this.store.now();
    if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)
      || issuedAt > now + GUEST_SELF_SERVE_SKEW_MS || now - issuedAt > GUEST_SELF_SERVE_FRESHNESS_MS) {
      fail(422, "stale_card", "The card signature is stale; sign a fresh joinRequest");
    }
    // Verify against the exact bytes the guest signed — joinRequest included,
    // so the binding above is cryptographically enforced, not just asserted.
    if (!verifyCardSignature({ agentId, card: cardInput, publicKey, signature })) {
      fail(401, "card_invalid", "The agent card signature did not verify");
    }
    // Per-key abuse gate, after the signature is known good.
    return this.store.transaction(() => {
      // True request-ID idempotency: an identical retry (same room, same
      // card key, same requestId) returns the originally issued credential —
      // no rotation, no quota consumed. The lookup runs after signature
      // verification, so only the key holder can replay; the per-key rate
      // gate below never sees a replay.
      const prior = this.idemRecord(roomId, keyHash, requestId);
      if (prior) {
        const live = this.db.prepare(
          "SELECT 1 FROM credentials WHERE hash=? AND room_id=? AND member_id=? AND kind='access' AND revoked=0 AND expires_at>?"
        ).get(hash(prior.token), roomId, prior.member_id, now);
        const replayMember = live && this.store.room(roomId).state.members[prior.member_id];
        // The seat must still be a live guest agent seat: if the owner has
        // repurposed the member (non-agent kind, non-guest id), the stale
        // record drops and the fresh path below fails 409 instead of
        // handing a guest token for a changed seat.
        if (replayMember && replayMember.active !== false
          && replayMember.kind === "agent" && isGuestAgentMemberId(replayMember.id)) {
          this.touchSelfServeSeat(roomId, prior.member_id, keyHash, now);
          return {
            token: prior.token,
            member: { id: replayMember.id, kind: replayMember.kind, permissions: [...replayMember.permissions], displayName: replayMember.displayName, expiresAt: prior.expires_at },
            room: { id: roomId },
            tier: "observer",
            scopes: [...GUEST_INVITE_TIERS.observer],
            expiresAt: prior.expires_at,
            hashPath: GUEST_INVITE_HASH_PATH,
            account: false,
            selfServed: true,
            renewed: prior.renewed === 1,
            replayed: true,
          };
        }
        // Superseded (rotated, revoked, or expired since issuance): drop the
        // stale record and fall through to a fresh issuance below.
        this.db.prepare("DELETE FROM guest_selfserve_idem WHERE room_id=? AND key_hash=? AND request_id=?")
          .run(roomId, keyHash, requestId);
      }
      // Per-key abuse gate, after the signature is known good. Idempotent
      // replays above never reach this gate.
      const keyGate = this.selfServeKeyLimiter.check(`guest-join:key:${keyHash}`);
      if (!keyGate.allowed) fail(429, "rate_limited", "Too many guest join requests for this agent card; try again tomorrow");
      const { card } = assertCardShape(cardInput);
      let room = this.store.room(roomId);
      refuseArchivedWrite(room.state);
      const ownerId = room.state.room.ownerId;
      // Sweep expired guest seats before any capacity decision.
      room = this.sweepExpiredGuests(roomId, room, ownerId);
      // One live pass per card key per room: the member id is deterministic
      // in the key, so a second request for the same key finds its member.
      // (identityId caps at 64 chars, so the fingerprint is truncated —
      // the member id hashes it anyway.)
      const identityId = `key:${keyHash.slice(0, 32)}`;
      const memberId = guestAgentMemberId(identityId, roomId);
      const existing = room.state.members[memberId];
      let isNewMember = false;
      if (existing) {
        if (existing.kind !== "agent" || !isGuestAgentMemberId(existing.id)) {
          fail(409, "seat_taken", "This agent card already holds a different seat in this room");
        }
        if (existing.active === false) {
          // Each reactivation needs a unique event id: reactivateGuestSeat
          // derives it from (member, inviteId), and a repeated id would be
          // deduped as a no-op by the journal. The guest_members rebind is
          // a harmless no-op for self-serve members (they have no row).
          room = this.reactivateGuestSeat(roomId, room, ownerId, `selfserve-${keyHash.slice(0, 16)}-${now}`, existing);
        }
      } else {
        const name = this.checkedGuestName(room.state, card.name);
        if (this.store.guestAgentLinks.liveCount(roomId) >= GUEST_AGENT_MAX_JOINS) {
          fail(429, "rate_limited", "This room is at its guest limit; ask the owner to disconnect a guest");
        }
        // Historical accumulation cap: at most GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM
        // self-serve seats per room. Beyond it, the least-recently-active
        // seat is evicted to make room — inactive history can never
        // accumulate unboundedly.
        if (this.db.prepare("SELECT COUNT(*) n FROM guest_selfserve WHERE room_id=?").get(roomId).n >= GUEST_SELF_SERVE_MAX_SEATS_PER_ROOM) {
          room = this.evictLruSelfServeSeat(roomId, room, ownerId, now);
        }
        const incoming = event({
          id: `guest-selfserve-${keyHash.slice(0, 40)}`,
          idempotencyKey: `guest-selfserve-${keyHash.slice(0, 40)}`,
          roomId, actorId: ownerId,
          type: T.MEMBER_ADDED, at: new Date(now).toISOString(),
          data: {
            memberId,
            displayName: `${name}${GUEST_BADGE_SUFFIX}`,
            kind: "agent",
            permissions: [],
            identityId,
            accountableHumanId: ownerId,
            authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
          },
        });
        let state;
        try {
          state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
        } catch (error) { fail(422, "command_rejected", error.message); }
        const projection = JSON.stringify(state), sequence = room.sequence + 1;
        if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room storage limit reached");
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
        this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
        isNewMember = true;
      }
      // A NEW requestId always mints a fresh pass (renewals included): revoke
      // any prior credential for this member, then issue. The idempotency
      // record is what makes an identical retry return the original
      // credential instead of rotating.
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=? AND kind='access'")
        .run(roomId, memberId);
      const token = newGuestToken();
      this.store.guestAgentLinks.conflict(hash(token));
      const expiresAt = now + GUEST_SELF_SERVE_TTL_MS;
      // parent_hash stays NULL: the key hash is not a credential, and the
      // FK points at credentials(hash). Key provenance lives on the member
      // (identityId = key:<fingerprint>).
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(token), roomId, memberId, expiresAt);
      // Record this (room, key, requestId) -> token so an identical retry
      // returns this exact credential. Older records for the key are
      // superseded by this rotation and are dropped.
      this.db.prepare("DELETE FROM guest_selfserve_idem WHERE room_id=? AND key_hash=?").run(roomId, keyHash);
      this.db.prepare("INSERT INTO guest_selfserve_idem(room_id, key_hash, request_id, token, member_id, expires_at, renewed, created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(roomId, keyHash, requestId, token, memberId, expiresAt, isNewMember ? 0 : 1, now);
      // Seat bookkeeping for the LRU accumulation cap (upsert: seats created
      // before this table existed gain their row on next use).
      this.touchSelfServeSeat(roomId, memberId, keyHash, now);
      const member = this.store.room(roomId).state.members[memberId];
      return {
        token,
        member: { id: member.id, kind: member.kind, permissions: [...member.permissions], displayName: member.displayName, expiresAt },
        room: { id: roomId },
        tier: "observer",
        scopes: [...GUEST_INVITE_TIERS.observer],
        expiresAt,
        hashPath: GUEST_INVITE_HASH_PATH,
        account: false,
        selfServed: true,
        renewed: !isNewMember,
      };
    });
  }

  checkedGuestName(state, name) {
    if (name.toLowerCase().endsWith(GUEST_BADGE_SUFFIX.trim().toLowerCase())) {
      fail(422, "card_invalid", "Guest names may not carry the (guest) badge themselves");
    }
    const lowered = name.toLowerCase();
    if (RESERVED_GUEST_NAMES.includes(lowered)) fail(422, "card_invalid", "That name is reserved");
    const taken = new Set();
    const owner = state.members[state.room.ownerId];
    if (owner?.displayName) taken.add(owner.displayName.toLowerCase());
    for (const member of Object.values(state.members)) {
      if (typeof member.displayName === "string") {
        taken.add(member.displayName.toLowerCase());
        taken.add(member.displayName.toLowerCase().replace(/\s*\(guest\)$/, ""));
      }
    }
    if (taken.has(lowered)) fail(422, "card_invalid", "That name is already in use in this room");
    return name;
  }

  list(token, roomId, binding) {
    return this.store.readTransaction(() => {
      this.ownerGate(token, roomId, binding);
      const now = this.store.now();
      return this.db.prepare("SELECT * FROM guest_invites WHERE room_id=? ORDER BY created_at DESC").all(roomId)
        .map(row => {
          // Public shape is camelCase; code hashes and the minter's account
          // id never leave the server.
          const { code_hash, minted_by_account_id } = row;
          void code_hash; void minted_by_account_id;
          return {
            inviteId: row.id,
            tier: row.tier,
            credentialTtlMs: row.credential_ttl_ms,
            guestLabel: row.guest_label,
            mintedByMemberId: row.minted_by_member_id,
            issueRequestId: row.issue_request_id,
            createdAt: row.created_at,
            redeemBy: row.redeem_by,
            status: row.status === "active" && row.redeem_by <= now ? "expired" : row.status,
            redeemedAt: row.redeemed_at,
            redeemedByIdentityId: row.redeemed_by_identity_id,
            redeemedMemberId: row.redeemed_member_id,
            revokedAt: row.revoked_at,
            revokedByMemberId: row.revoked_by_member_id,
          };
        });
    });
  }

  revoke(token, roomId, inviteId, binding) {
    if (!validId(inviteId)) fail(422, "invalid_guest_invite", "Supply the invite id");
    return this.store.transaction(() => {
      const auth = this.ownerGate(token, roomId, binding);
      const row = this.db.prepare("SELECT * FROM guest_invites WHERE id=? AND room_id=?").get(inviteId, roomId);
      if (!row) fail(404, "invite_not_found", "No such guest invite in this room");
      if (row.status !== "active") fail(409, "invite_not_active", "Only an unredeemed invite can be revoked");
      this.db.prepare("UPDATE guest_invites SET status='revoked', revoked_at=?, revoked_by_member_id=? WHERE id=?")
        .run(this.store.now(), auth.member.id, inviteId);
      return { revoked: true, inviteId };
    });
  }

  // Owner disconnects one guest: credential revoked, member deactivated
  // immediately, journaled. The guest's messages stay in history, badged.
  disconnect(token, roomId, memberId, binding) {
    if (!isGuestAgentMemberId(memberId)) fail(422, "invalid_guest_invite", "That member is not a guest");
    return this.store.transaction(() => {
      this.ownerGate(token, roomId, binding);
      const member = this.store.room(roomId).state.members[memberId];
      if (!member || member.kind !== "agent" || member.active === false) fail(404, "guest_not_found", "No active guest with that member id");
      const isKnownGuest = !!this.db.prepare("SELECT 1 FROM guest_members WHERE member_id=? AND room_id=?").get(memberId, roomId);
      const hasLiveCredential = !!this.db.prepare(
        "SELECT 1 FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0 AND expires_at>?")
        .get(roomId, memberId, this.store.now());
      if (!isKnownGuest && !hasLiveCredential) fail(404, "guest_not_found", "No active guest with that member id");
      this.store.command(token, roomId, {
        id: `guest-disconnect-${hash(`${memberId}:${this.store.now()}`).slice(0, 40)}`,
        type: T.MEMBER_ACCESS_CHANGED,
        data: { memberId, expectedMemberRevision: member.revision, active: false, permissions: member.permissions },
      }, binding);
      return { disconnected: true, memberId };
    });
  }

  // Panic switch: every guest in the room, one call, each deactivation
  // journaled under the owner.
  revokeAll(token, roomId, binding) {
    return this.store.transaction(() => {
      this.ownerGate(token, roomId, binding);
      const members = this.store.room(roomId).state.members;
      let n = 0;
      for (const row of this.db.prepare("SELECT member_id FROM guest_members WHERE room_id=?").all(roomId)) {
        const member = members[row.member_id];
        if (!member || member.kind !== "agent" || member.active === false || !isGuestAgentMemberId(member.id)) continue;
        this.store.command(token, roomId, {
          id: `guest-revoke-all-${hash(`${member.id}:${this.store.now()}:${n}`).slice(0, 40)}`,
          type: T.MEMBER_ACCESS_CHANGED,
          data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions },
        }, binding);
        n++;
      }
      // Legacy ga1. members (owner-minted, no guest_members row) ride the
      // same panic switch.
      for (const member of Object.values(members)) {
        if (!isGuestAgentMemberId(member.id) || member.kind !== "agent" || member.active === false) continue;
        if (this.db.prepare("SELECT 1 FROM guest_members WHERE member_id=?").get(member.id)) continue;
        this.store.command(token, roomId, {
          id: `guest-revoke-all-${hash(`${member.id}:${this.store.now()}:legacy:${n}`).slice(0, 40)}`,
          type: T.MEMBER_ACCESS_CHANGED,
          data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions },
        }, binding);
        n++;
      }
      return { revoked: n };
    });
  }

  // Owner upgrades (or downgrades) a guest's tier. Contributor is never
  // granted at mint or redemption — it is always an explicit owner decision.
  // Returning identities keep their existing tier on re-redemption; only
  // this operation changes it. The tier lives in guest_members and is read
  // on every command, so the change takes effect immediately.
  upgrade(token, roomId, memberId, tier, binding) {
    if (!isGuestAgentMemberId(memberId)) fail(422, "invalid_guest_invite", "That member is not a guest");
    if (!Object.hasOwn(GUEST_INVITE_TIERS, tier)) fail(422, "invalid_guest_invite", "Tier is observer or contributor");
    return this.store.transaction(() => {
      this.ownerGate(token, roomId, binding);
      const seat = this.db.prepare("SELECT tier FROM guest_members WHERE member_id=? AND room_id=?").get(memberId, roomId);
      if (!seat) fail(404, "guest_not_found", "No guest seat with that member id");
      const member = this.store.room(roomId).state.members[memberId];
      if (!member || member.kind !== "agent" || member.active === false) fail(404, "guest_not_found", "No active guest with that member id");
      if (seat.tier === tier) return { memberId, tier, unchanged: true };
      // The tier change is journaled as a MEMBER_ACCESS_CHANGED carrying
      // exactly the validator's four fields — no `tier` key: the tier itself
      // lives in guest_members, and the journal records the owner as actor
      // at the moment of the change. (A `tier` field here is rejected by
      // strict command validation: "Unexpected field: tier".)
      this.store.command(token, roomId, {
        id: `guest-tier-${hash(`${memberId}:${tier}:${this.store.now()}`).slice(0, 40)}`,
        type: T.MEMBER_ACCESS_CHANGED,
        data: { memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: true },
      }, binding);
      this.db.prepare("UPDATE guest_members SET tier=? WHERE member_id=? AND room_id=?").run(tier, memberId, roomId);
      return { memberId, tier, unchanged: false };
    });
  }

  // The guest rotates its own credential inside the TTL: leak response
  // without waiting on the owner. Same member, same tier, same expiry.
  rotate(guestToken, roomId, binding) {
    if (!GUEST_AGENT_TOKEN_PATTERN.test(guestToken)) fail(410, "invite_unavailable", "This guest credential is not valid.");
    return this.store.transaction(() => {
      const auth = this.store.authenticate(guestToken, roomId, binding, { allowAccountSession: false });
      const member = auth.member;
      if (!member || !isGuestAgentMemberId(member.id) || member.kind !== "agent" || member.active === false) {
        fail(403, "guest_only", "Only a guest credential can rotate itself");
      }
      const row = this.store.guestAgentLinks.credential(guestToken);
      if (!row || row.revoked !== 0 || row.expires_at <= this.store.now() || row.member_id !== member.id) {
        fail(410, "invite_unavailable", "This guest credential is not valid.");
      }
      const token = newGuestToken();
      this.store.guestAgentLinks.conflict(hash(token));
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(token), roomId, member.id, row.expires_at);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(guestToken));
      return { token, member: { id: member.id, expiresAt: row.expires_at }, room: { id: roomId }, expiresAt: row.expires_at };
    });
  }
}
