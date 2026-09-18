// Open rooms: join by shareable link alone (Uuriko/project-room#612).
//
// An owner flips a room's `openJoin` policy; after that, anyone holding the
// shareable room link — a human with an account session or an agent with a
// minted pri_ identity secret — joins with a single call, no invite
// round-trip. The link is the invitation: a missing room, a malformed id and
// a room whose policy is closed all answer the same 404, so open join never
// becomes a room-enumeration oracle.
//
// Joins land with the fixed chat profile ([] additional permissions: read
// and post, no work, no admin) and are audited as member.added with
// basis:"open_join". Standing authorization: the owner's openJoin policy is
// the grant, so the owner is recorded as the granting actor and basis
// distinguishes policy-driven joins from personal adds. An open room is a
// public square — nothing posted there should be treated as private.

import { createHash, randomUUID } from "node:crypto";
import { event, EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION, roomPolicy, validId } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { agentAccessProfiles } from "./agent-connections.mjs";
import { refuseArchivedWrite } from "./room-lifecycle.mjs";
import { isIdentitySecret } from "./agent-identities.mjs";
import { createRateLimiter } from "./identity-ratelimit.mjs";

// Local ServiceError (mirrors server/store.mjs): this module is constructed
// in server/http.mjs and never imported by server/store.mjs, so importing
// ServiceError from the store would build the Workers-bundle cycle that
// server/access-requests.mjs documents.
class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = text => createHash("sha256").update(text).digest("hex");
// Mirrors the projection compaction in store.mjs: strip replay-only caches.
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

// The chat profile: membership itself grants read + post; there are no
// additional permissions. No work submission, no administration — an open
// room is a public square, not a workspace.
const CHAT_PERMISSIONS = Object.freeze([...agentAccessProfiles.chat]);

// No-enumeration: a missing room, a malformed id and a closed room answer
// identically. Only an open room's existence is ever revealed — the
// shareable link is the invitation by design.
const joinUnavailable = () => fail(404, "join_unavailable", "This room is not open for joining");

export class OpenJoin {
  constructor(store, { rateLimiter } = {}) {
    this.store = store;
    this.db = store.db;
    // Joins are rare and sensitive: 10 per hour per joiner blunts
    // credential-guessing across rooms while never blocking the legitimate
    // two-call funnel (identity-create, then join).
    this.rateLimiter = rateLimiter ?? createRateLimiter({ capacity: 10, refillPerSecond: 10 / 3600 });
  }

  // Joins an open room. secret is either a pri_ identity secret (agent) or a
  // human account session token; displayName is optional and defaults to the
  // identity's display name (agents) or "Room member" (humans). Returns the
  // membership receipt; a repeat join by the same joiner returns
  // { alreadyMember: true } without writing.
  join(roomId, secret, { displayName } = {}) {
    if (typeof roomId !== "string" || !validId(roomId)) joinUnavailable();
    const room = this.openRoom(roomId);
    const joiner = this.resolveJoiner(secret, displayName);
    const now = this.store.now();
    refuseArchivedWrite(room.state);
    return this.store.transaction(() => {
      // Idempotent rejoin short-circuits before the rate limiter: a client
      // that retries join on every connect must not burn its join budget.
      const existing = this.existingMembership(roomId, joiner);
      if (existing) return { roomId, memberId: existing, alreadyMember: true, kind: joiner.kind };
      const limit = this.rateLimiter.check(`open-join:${joiner.rateKey}`);
      if (!limit.allowed) fail(429, "rate_limited", limit.message);
      if (room.sequence >= 10000 || Object.keys(room.state.members).length >= 100) {
        fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      }
      return this.applyJoin(roomId, room, joiner, now);
    });
  }

  // 404 unless the room exists and its policy is open. The policy check runs
  // before credential validation so a closed room never leaks through a
  // valid credential.
  openRoom(roomId) {
    let room;
    try { room = this.store.room(roomId); }
    catch { joinUnavailable(); }
    if (roomPolicy(room.state).openJoin !== true) joinUnavailable();
    return room;
  }

  resolveJoiner(secret, displayName) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (name.length > 80) fail(422, "invalid_join", "displayName must be 1-80 characters");
    if (typeof secret === "string" && isIdentitySecret(secret)) {
      const identity = this.db.prepare("SELECT identity_id, display_name FROM agent_identities WHERE secret_hash=?").get(hash(secret));
      if (!identity) fail(401, "unauthenticated", "Invalid identity secret");
      return {
        kind: "agent",
        memberId: identity.identity_id,
        identityId: identity.identity_id,
        displayName: name || identity.display_name,
        rateKey: `identity:${identity.identity_id}`,
      };
    }
    // Human path: a current account session. authenticateAccountSession
    // rejects expired, revoked and otherwise invalid sessions with 401.
    const auth = this.store.authenticateAccountSession(secret, null, null);
    const accountId = auth.account.id;
    return {
      kind: "human",
      memberId: `human-${hash(`open-join-member:${accountId}`).slice(0, 12)}`,
      accountId,
      displayName: name || "Room member",
      rateKey: `account:${accountId}`,
    };
  }

  // A link or account binding from a previous join makes the rejoin
  // idempotent — even if the owner later removed the member, open join does
  // not resurrect the membership; the removal stands.
  existingMembership(roomId, joiner) {
    const row = joiner.kind === "agent"
      ? this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, joiner.identityId)
      : this.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, joiner.accountId);
    return row?.member_id ?? null;
  }

  applyJoin(roomId, room, joiner, now) {
    const ownerId = room.state.room.ownerId;
    const incoming = event({
      id: randomUUID(),
      idempotencyKey: hash(`open-join:${roomId}:${joiner.rateKey}`),
      type: T.MEMBER_ADDED,
      roomId,
      actorId: ownerId,
      at: new Date(now).toISOString(),
      data: {
        memberId: joiner.memberId,
        displayName: joiner.displayName,
        kind: joiner.kind,
        permissions: [...CHAT_PERMISSIONS],
        ...(joiner.identityId ? { identityId: joiner.identityId } : {}),
        basis: "open_join",
        authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
      },
    });
    let state;
    try { state = compactState(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
    catch (error) { fail(409, "join_rejected", error.message); }
    const projection = JSON.stringify(state);
    if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
    if (joiner.kind === "agent") {
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, joiner.identityId, joiner.memberId, now);
    } else {
      this.store.ensureHumanAccountBinding(roomId, joiner.memberId, joiner.accountId, "open-join");
    }
    return {
      roomId,
      memberId: joiner.memberId,
      kind: joiner.kind,
      permissions: [...CHAT_PERMISSIONS],
      displayName: joiner.displayName,
      joinedAt: incoming.at,
      alreadyMember: false,
    };
  }
}
