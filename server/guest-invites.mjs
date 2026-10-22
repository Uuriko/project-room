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
import { PILOT_LIMITS, activeMemberCount } from "./store.mjs";
import { storeProjectionCapBytes } from "./storage-limits.mjs";
import { createHash, randomBytes } from "node:crypto";
import { EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION, event, validId } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { verifyCardSignature } from "./agent-card-signing.mjs";
import {
  GUEST_AGENT_TOKEN_PREFIX,
  GUEST_AGENT_TOKEN_PATTERN,
  GUEST_AGENT_MAX_JOINS,
  guestAgentMemberId,
  isGuestAgentMemberId,
} from "./guest-agent-links.mjs";
import { guestHistoryAccessLead } from "./history-visibility.mjs";

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
// Self-serve guest entry (RC-2026-09-25-912) was removed in #3219: guests
// are owner-issued trial seats only. The guest_selfserve tables below stay
// as inert legacy — existing seats expire naturally and no data is
// deleted — but no code reads or writes them now.
export const GUEST_INVITE_REDEEM_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const GUEST_INVITE_REDEEM_MIN_MS = 60 * 60 * 1000;
export const GUEST_INVITE_REDEEM_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Concurrent external guests per room. The existing ga1. ceiling
// (GUEST_AGENT_MAX_JOINS = 10) stays as the absolute member cap.
export const GUEST_INVITE_MAX_ACTIVE_PER_ROOM = 5;
const GUEST_ACCESS_TEXT = "Read the room and its history, post messages, and react. Drafts only with the contributor tier. No work lifecycle, invites, polls, or administration.";

// Trial-seat guidance handed to a redeeming guest (#3214): the join
// responses are where the guest ceiling must be disclosed — claiming work
// returns 403 guest_scope_denied and the credential cannot be renewed —
// together with the paths to full membership and the orientation surface.
// Mirrors the `next` arrays the identity mint and agent-invite redeem
// already return.
const guestTrialNext = (roomId, expiresAt) => [
  `Orient: GET /api/rooms/${roomId}/activation-pack`,
  "Trial seat: claiming work is reserved for full members — guest claim attempts return 403 guest_scope_denied",
  `Your guest credential expires at ${new Date(expiresAt).toISOString()} and cannot be renewed; the room owner can issue a fresh invite`,
  "For full membership, ask the room owner to upgrade this guest seat or send you an agent invite, then redeem it: POST /api/agent-invites/redeem"
];

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
// Security: guest_selfserve_idem holds the token HASH, never the plaintext
// credential. An identical retry returns status/member/expiresAt with
// replayed:true, but the Bearer <redacted> is only ever returned in the
// first (non-replay) response — the client must persist it. This prevents
// a captured signed request from being replayed to recover the live token.
// The room SQLite store is operator-local; at most one record lives per
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
    token_hash TEXT NOT NULL CHECK(length(token_hash)=64),
    member_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    renewed INTEGER NOT NULL CHECK(renewed IN (0,1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, key_hash, request_id)
  );
`;

// Issuing-authority provenance for guest invites (F-5). Kept as a SEPARATE
// schema string from guestInviteSchema, the guestSelfServeSchema pattern:
// the invite row itself predates provenance, and a delegate mint stores
// minted_by_account_id = NULL by design (delegates are accountless), which
// left delegate-minted invites invisible to account deletion's by-account
// revocation. Each row names the account the mint's authority traces to —
// the minter's own account, or for a delegate the room owner's account —
// and whether the mint rode a delegation grant. Deletion revokes invites
// whose authority account is deleted; redemption re-checks that the
// authority still stands (the share-link issuer-liveness pattern). The
// authority member id is the accountable human for the redemption event:
// the member reducer requires an accountable HUMAN sponsor, and a
// delegate minter is an agent — without the granting owner recorded here,
// a delegate-minted invite could never redeem at all.
export const guestInviteAuthoritySchema = `
  CREATE TABLE IF NOT EXISTS guest_invite_authority (
    invite_id TEXT PRIMARY KEY REFERENCES guest_invites(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    authority_account_id TEXT,
    authority_member_id TEXT,
    minted_via_delegate INTEGER NOT NULL DEFAULT 0 CHECK(minted_via_delegate IN (0,1))
  );
  CREATE INDEX IF NOT EXISTS guest_invite_authority_account ON guest_invite_authority(authority_account_id, invite_id);
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
    // #3432: "owner_only" alone taught a door agent owners cannot open.
    // The minter must carry the owner's account (signed-in account
    // session) or an owner delegate granted by that account — an agent
    // identity bearer cannot mint, even as the room's owner.
    mintRequires: "owner_account_session_or_delegate",
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
  constructor(store) {
    this.store = store; this.db = store.db;
  }

  verifySchema(opts) {
    return verifySchemaText(this.db, guestInviteSchema, "Guest invite")(opts);
  }

  verifySelfServeSchema(opts) {
    return verifySchemaText(this.db, guestSelfServeSchema, "Guest self-serve")(opts);
  }

  verifyAuthoritySchema(opts) {
    return verifySchemaText(this.db, guestInviteAuthoritySchema, "Guest invite authority")(opts);
  }

  // F-5: an invite stands on its issuing authority for its whole redeem
  // window. If that authority is gone — the granting account deleted or
  // deactivated, or the delegation a delegate minted under has lapsed —
  // the invite fails closed, the same issuer-liveness recheck share links
  // perform on every use. Invites minted before provenance was recorded
  // carry no authority row and keep the invite-row-only behavior.
  provenanceOf(inviteId) {
    return this.db.prepare("SELECT * FROM guest_invite_authority WHERE invite_id=?").get(inviteId);
  }

  assertIssuingAuthorityLive(row) {
    const provenance = this.provenanceOf(row.id);
    if (!provenance) return;
    if (provenance.authority_account_id) {
      const account = this.db.prepare("SELECT active FROM accounts WHERE id=?").get(provenance.authority_account_id);
      if (!account || account.active !== 1) fail(410, "invite_unavailable", "This guest invite is not valid.");
    }
    if (provenance.minted_via_delegate) {
      // The minter's authority was a delegation grant. It stands only
      // while the grant stands — unless the minter has since become the
      // room owner, in which case the authority is their own.
      const ownerId = this.store.room(row.room_id).state.room?.ownerId;
      if (row.minted_by_member_id !== ownerId) {
        const identityId = this.store.identities.identityIdForMember(row.room_id, row.minted_by_member_id);
        if (!identityId || !this.store.ownerDelegates.hasGrant(row.room_id, identityId)) {
          fail(410, "invite_unavailable", "This guest invite is not valid.");
        }
      }
    }
  }

  // Owner-only gate. v1 keeps the human owner as the single trust anchor;
  // delegating mint to lanes is a later decision, not a code gap.
  ownerGate(token, roomId, binding) {
    const auth = this.store.guestAgentLinks.owner(token, roomId, binding);
    // The mint itself is account-bound (see mint), but an owner delegate is
    // accountless by design: their authority comes from the owner's
    // persisted grant (server/owner-delegates.mjs), not a signed-in account
    // session.
    // #3432: this refusal gets its own registry-born code
    // (guest_invite_account_session_required, src/agent-error.mjs). Every
    // caller who reaches it IS the owner or their delegate, so the shared
    // account_session_required envelope — whose generic 403 recovery is
    // "Ask the owner to mint a guest invite" — was a self-loop for them.
    // The registry entry addresses the owner and names the real remedies.
    if (!auth.account && !auth.delegate) fail(403, "guest_invite_account_session_required", "Guest invites are managed from the room owner's signed-in account session");
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

  // Direct guest admission and reactivation do not pass through
  // RoomStore.command's MEMBER_ADDED budget gate. Keep the same active-seat
  // ceiling, and reserve room-event capacity for the event about to land.
  admissionBudget(room) {
    if (room.sequence >= PILOT_LIMITS.eventsPerRoom
      || activeMemberCount(room.state.members) >= PILOT_LIMITS.membersPerRoom) {
      fail(409, "pilot_limit", "Bounded pilot capacity reached; no guest was admitted");
    }
  }

  // Journaled guest-seat deactivation shared by the expiry sweep and the LRU
  // accumulation-cap eviction: builds the MEMBER_ACCESS_CHANGED event
  // directly (the self-serve redemption pattern) with the sponsoring owner
  // as actor, replicating store.command's deactivating side effects
  // (connection revocation, credential revocation, reminder retirement) so
  // every deactivation flavor leaves the same wake. Returns the refreshed
  // room ({ sequence, state }).
  deactivateGuestSeat(roomId, room, actorMemberId, member, eventId) {
    // Expiry and eviction end access. Like RoomStore.command's cleanup
    // exception, allow this deactivation even at the event ceiling.
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
    const projection = this.store.storedProjection(roomId, state);
    if (Buffer.byteLength(projection) > storeProjectionCapBytes(this.store)) fail(409, "pilot_limit", "Room storage limit reached; no data was changed. Ask the room owner to have older messages archived to free space.");
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
      // Guests accumulate credential rows (rotation and renewal revoke the
      // old row and insert a fresh one), so judge the seat by an unrevoked
      // row only: an arbitrary row may be a revoked predecessor whose live
      // successor must keep the seat. Mirrors GuestAgentLinks#sweepExpired.
      const cred = this.db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0")
        .get(roomId, member.id);
      if (cred && cred.revoked === 0 && cred.expires_at > this.store.now()) continue;
      const eventId = `guest-agent-end-${hash(`${member.id}:${cred?.hash || "none"}`).slice(0, 40)}`;
      room = this.deactivateGuestSeat(roomId, room, actorMemberId, member, eventId);
    }
    return room;
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
    this.admissionBudget(room);
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
    const projection = this.store.storedProjection(roomId, state), sequence = room.sequence + 1;
    if (Buffer.byteLength(projection) > storeProjectionCapBytes(this.store)) fail(409, "pilot_limit", "Room storage limit reached; no data was changed. Ask the room owner to have older messages archived to free space.");
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
      // Invitation issuance carries the f520ca69 email-verification gate,
      // same as agent-invites.create and share-link creation. Owner
      // delegates are accountless by design (no account to verify).
      if (auth.account) this.store.accountLogins.assertEmailVerified(auth.account.id);
      // The freshness check pins the OWNER's member revision: the minter
      // asserts they saw the current owner state. A delegate's own member
      // revision is irrelevant to their delegated authority, so the check
      // always reads the owner's record.
      const authority = this.store.roomAuthority(roomId);
      if (expectedOwnerRevision !== authority.members[authority.ownerId]?.revision) fail(409, "stale_member_revision", "Your room permissions changed; refresh before minting");
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
          auth.member.id, auth.account?.id ?? null, requestId, now, now + redeemWindowMs);
      // F-5 provenance: record the authority this mint stood on, in the
      // same transaction. An account mint stands on the minter's account;
      // a delegate mint (accountless by design) stands on the room owner's
      // account, resolved through the owner's member binding — without it,
      // deletion's by-account revocation could never find these invites.
      const authorityAccountId = auth.account?.id
        ?? this.db.prepare("SELECT account_id AS accountId FROM member_accounts WHERE room_id=? AND member_id=?")
          .get(roomId, authority.ownerId)?.accountId ?? null;
      this.db.prepare(`INSERT INTO guest_invite_authority(invite_id, room_id, authority_account_id, authority_member_id, minted_via_delegate)
        VALUES(?,?,?,?,?)`)
        .run(inviteId, roomId, authorityAccountId, authority.ownerId, auth.delegate ? 1 : 0);
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
      // #3214: the minting owner sees the trial terms they are issuing —
      // the same access text the contract and the invite preview serve.
      access: GUEST_ACCESS_TEXT,
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
      this.assertIssuingAuthorityLive(row);
      const room = this.store.room(row.room_id).state.room;
      return {
        room: { id: room.id, title: room.title },
        kind: "guest-invite",
        tier: row.tier,
        scopes: [...GUEST_INVITE_TIERS[row.tier]],
        access: `${guestHistoryAccessLead(room)}, post messages, and react. Drafts only with the contributor tier. No work lifecycle, invites, polls, or administration.`,
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
      this.assertIssuingAuthorityLive(row);
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
        this.admissionBudget(room);
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
            // F-5: for a delegate-minted invite the accountable human is
            // the granting owner recorded in the provenance row — the
            // delegate is an agent and cannot be its own accountable
            // sponsor (the reducer refuses a non-human sponsor).
            accountableHumanId: this.provenanceOf(row.id)?.authority_member_id ?? row.minted_by_member_id,
            authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
          },
        });
        let state;
        try {
          state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
        } catch (error) { fail(422, "command_rejected", error.message); }
        const projection = this.store.storedProjection(roomId, state), sequence = room.sequence + 1;
        if (Buffer.byteLength(projection) > storeProjectionCapBytes(this.store)) fail(409, "pilot_limit", "Room storage limit reached; no data was changed. Ask the room owner to have older messages archived to free space.");
        this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
        this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
        this.db.prepare("INSERT INTO guest_members(member_id, room_id, guest_identity_id, tier, invite_id, created_at) VALUES(?,?,?,?,?,?)")
          .run(memberId, roomId, identity.identityId, row.tier, row.id, now);
      }
      // Burn the invite: single-use, bound to the identity that redeemed it.
      this.db.prepare("UPDATE guest_invites SET status='redeemed', redeemed_at=?, redeemed_by_identity_id=?, redeemed_member_id=? WHERE id=? AND status='active'")
        .run(this.store.now(), identity.identityId, memberId, row.id);
      const token = newGuestToken();
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
        // #3214: disclose the trial scope and the way forward at join
        // time, not at the first 403: same access text as the contract
        // and preview, plus the guest-facing next steps.
        access: GUEST_ACCESS_TEXT,
        next: guestTrialNext(roomId, expiresAt),
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
    // John's pass-5 rule ("does the error teach?"): validate the caller's
    // fields before diagnosing membership state, so a malformed request
    // never misreads as "not a guest".
    if (typeof memberId !== "string" || !memberId) {
      fail(422, "invalid_guest_invite", "memberId is required: the guest member to upgrade (a guest-agent-* id)");
    }
    if (!isGuestAgentMemberId(memberId)) {
      fail(422, "invalid_guest_invite", "That member is not a guest: memberId must be a guest agent id (guest-agent-...)");
    }
    if (tier === undefined || tier === null) {
      fail(422, "invalid_guest_invite", "tier is required: observer or contributor");
    }
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
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(token), roomId, member.id, row.expires_at);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(guestToken));
      return { token, member: { id: member.id, expiresAt: row.expires_at }, room: { id: roomId }, expiresAt: row.expires_at };
    });
  }
}
