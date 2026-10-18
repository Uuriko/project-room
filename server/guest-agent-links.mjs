import { createHash } from "node:crypto";
import { EVENT_TYPES as T, event } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
// Read at call time (store.mjs imports this module): one source for capacity.
import { PILOT_LIMITS } from "./store.mjs";

// Guest-agent tier primitives + seat machinery, shared by guest-invites v1
// (server/guest-invites.mjs). The v0 link-exchange system that originally
// lived here — owner-minted ga1. links with mint/preview/join/refresh
// routes — was cut in issue #3216: it was superseded by guest-invites v1
// (owner-minted GX- codes redeeming into the same ga1. tier). What remains
// is what v1 and the rest of the server still build on: the token/member-id
// shapes every classifier checks, and the seat machinery guest-invites
// calls through the store (owner gate, credential liveness, expiry sweep,
// live-seat count).

class GuestAgentLinkError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new GuestAgentLinkError(status, code, message); };
const hash = value => createHash("sha256").update(value).digest("hex");

// Human share tokens stay 43 chars. Guest-agent tokens are a different shape so
// they can never be redeemed through /api/share-links or #join/.
export const GUEST_AGENT_TOKEN_PREFIX = "ga1.";
export const GUEST_AGENT_TOKEN_PATTERN = /^ga1\.[A-Za-z0-9_-]{43}$/;
export const HUMAN_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ROOM_ACCESS_TOKEN_PATTERN = /^(?:[A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43})$/;
export const GUEST_AGENT_HASH_PATH = "#agent-join/";
export const HUMAN_SHARE_HASH_PATH = "#join/";
export const GUEST_AGENT_KIND = "agent";
export const GUEST_AGENT_PERMISSIONS = Object.freeze([]);
export const GUEST_AGENT_MAX_JOINS = 10;
export const GUEST_AGENT_MEMBER_PREFIX = "guest-agent-";
// GA-2 (issue #941): single-use link redemptions. The v0 join() that wrote
// this table was cut with the rest of the v0 exchange (#3216); the table is
// retained read-only for audit — no writer remains, and no rows are deleted.
export const guestLinkExchangeSchema = `
  CREATE TABLE IF NOT EXISTS guest_link_exchanges (
    link_hash TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_hash TEXT NOT NULL,
    exchanged_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS guest_link_exchanges_seat ON guest_link_exchanges(room_id, member_id);
`;

export function isRoomAccessToken(token) {
  return typeof token === "string" && ROOM_ACCESS_TOKEN_PATTERN.test(token);
}

export function classifyJoinToken(token) {
  if (typeof token !== "string") return "invalid";
  if (GUEST_AGENT_TOKEN_PATTERN.test(token)) return "guest-agent";
  if (HUMAN_SHARE_TOKEN_PATTERN.test(token)) return "human-share";
  return "invalid";
}

export function guestAgentMemberId(accountId, requestId) {
  return GUEST_AGENT_MEMBER_PREFIX + hash(`${accountId}:${requestId}`).slice(0, 24);
}

export function isGuestAgentMemberId(memberId) {
  return typeof memberId === "string" && memberId.startsWith(GUEST_AGENT_MEMBER_PREFIX);
}

// Seat machinery for the guest-agent tier. guest-invites v1 reaches these
// through the store: the owner gate for its mint, the expiry sweep before
// minting, the live-seat count for its per-room cap, and the credential
// lookup when a guest bearer is presented.
export class GuestAgentLinks {
  constructor(store) { this.store = store; this.db = store.db; }

  owner(token, roomId, binding) {
    // Owner delegates (server/owner-delegates.mjs) arrive via
    // store.authenticate with the delegate flag stamped on the member copy:
    // the journal keeps the delegate as the actor.
    const auth = this.store.authenticate(token, roomId, binding);
    // #643: owner-by-id — the owner capability follows the owner identity,
    // not the credential flavor (share-links-style owner-capability
    // exemption): an agent owner may mint guest links on their identity
    // bearer. The mint itself stays account-bound: guest member ids derive
    // from the sponsor account (see guest-invites.mjs).
    if (!auth.delegate && (auth.member?.id !== this.store.room(roomId).state.room.ownerId
      || !auth.member.permissions.includes("manage_members"))) {
      fail(403, "owner_required", "Only the room owner can mint a guest invite. Use Add agent for a durable key.");
    }
    return auth;
  }

  credential(token) {
    return this.db.prepare("SELECT * FROM credentials WHERE hash=?").get(hash(token));
  }

  liveCredential(row, member) {
    return row && row.kind === "access" && row.revoked === 0 && row.expires_at > this.store.now()
      && row.account_id === null && member?.kind === GUEST_AGENT_KIND && member.active !== false
      && isGuestAgentMemberId(member.id);
  }

  liveCount(roomId) {
    const members = this.store.room(roomId).state.members;
    let n = 0;
    for (const member of Object.values(members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== GUEST_AGENT_KIND || member.active === false) continue;
      const row = this.db.prepare("SELECT revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0").get(roomId, member.id);
      if (row && row.revoked === 0 && row.expires_at > this.store.now()) n++;
    }
    return n;
  }

  sweepExpired(token, roomId, binding) {
    // A delegate's member record carries no manage_members, so store.command
    // (which re-authenticates from the token and would be rejected by the
    // reducer for the delegate actor) cannot run for it: the delegate flavor
    // below builds the same MEMBER_ACCESS_CHANGED events directly — the
    // same pattern as GuestInvites#deactivateGuestSeat — with the delegation
    // provenance recorded in the event data.
    const auth = this.store.authenticate(token, roomId, binding);
    if (auth.delegate) return this.sweepExpiredAsDelegate(roomId, auth);
    const members = this.store.room(roomId).state.members;
    for (const member of Object.values(members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== GUEST_AGENT_KIND || member.active === false) continue;
      const row = this.db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0").get(roomId, member.id);
      if (row && row.revoked === 0 && row.expires_at > this.store.now()) continue;
      this.store.command(token, roomId, {
        id: `guest-agent-end-${hash(`${member.id}:${row?.hash || "none"}`).slice(0, 40)}`,
        type: T.MEMBER_ACCESS_CHANGED,
        data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions }
      }, binding);
    }
  }

  sweepExpiredAsDelegate(roomId, auth) {
    // The event model requires member.access_changed to be actor-attributed
    // to a member with manage_members, so the mechanical expiry sweep runs
    // as the room owner whose authority the delegate exercises (exactly as
    // the non-delegate sweep attributes to the minting owner). The real
    // actor and the delegation source ride explicitly in the event data;
    // the delegate's own mint stays credited to the delegate in
    // guest_invites.
    const ownerId = this.store.room(roomId).state.room.ownerId;
    const grantedBy = this.db.prepare(
      "SELECT granted_by FROM owner_delegate_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL")
      .get(roomId, auth.identityId)?.granted_by ?? ownerId;
    const room = this.store.room(roomId);
    let state = room.state, sequence = room.sequence, swept = 0;
    for (const member of Object.values(room.state.members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== GUEST_AGENT_KIND || member.active === false) continue;
      const row = this.db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0").get(roomId, member.id);
      if (row && row.revoked === 0 && row.expires_at > this.store.now()) continue;
      const eventId = `guest-agent-end-${hash(`${member.id}:${row?.hash || "none"}`).slice(0, 40)}`;
      const incoming = event({
        id: eventId,
        idempotencyKey: eventId,
        roomId,
        actorId: ownerId,
        type: T.MEMBER_ACCESS_CHANGED,
        at: new Date(this.store.now()).toISOString(),
        data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions,
          // Delegation provenance as flat top-level keys: the event envelope
          // validator (src/events.js) only accepts plain objects for a
          // whitelisted set of keys, so the provenance rides as *Id-suffixed
          // strings, which the validator already checks with validId().
          delegatedSweepByMemberId: auth.member.id, delegatedSweepByIdentityId: auth.identityId,
          delegatedSweepGrantedBy: grantedBy },
      });
      try {
        state = { ...applyEventWithGrowth(state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      } catch (error) {
        fail(422, "command_rejected", error.message);
      }
      sequence += 1;
      this.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
      this.store.agentConnections.revokeMember(roomId, member.id);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, member.id);
      this.store.reminders.retireMember(roomId, member.id);
      swept += 1;
    }
    if (swept === 0) return;
    const projection = this.store.storedProjection(roomId, state);
    if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "Room storage limit reached; no data was changed. Ask the room owner to raise the room's limit, or try again later.");
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
  }
}
