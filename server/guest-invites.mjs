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
import { verifyCardSignature } from "./agent-card-signing.mjs";
import {
  GUEST_AGENT_TOKEN_PREFIX,
  GUEST_AGENT_TOKEN_PATTERN,
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
  constructor(store) { this.store = store; this.db = store.db; }

  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = guestInviteSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Guest invite schema requires operator reconciliation");
    }
    return true;
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
    const tier = details.tier ?? "observer";
    if (!Object.hasOwn(GUEST_INVITE_TIERS, tier)) fail(422, "invalid_guest_invite", "Tier is observer or contributor");
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
      const room = this.store.room(roomId);
      refuseArchivedWrite(room.state);
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
      } else {
        const name = this.checkedGuestName(room.state, card.name);
        if (this.activeGuestCount(roomId) >= GUEST_INVITE_MAX_ACTIVE_PER_ROOM) {
          fail(429, "rate_limited", "This room is at its concurrent external-guest limit; ask the owner to disconnect a guest");
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
          const { code_hash, minted_by_account_id, ...rest } = row;
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
