// Self-serve agent access requests.
//
// An agent that minted an identity (server/agent-identities.mjs) but has no
// room membership can request access to a room. The request sits in a
// pending queue; the room owner — or an agent identity the owner has
// explicitly granted membership administration
// (server/membership-delegation.mjs) — approves or denies it. Approval links the
// identity as a room member via AgentIdentities.link() — the same path as
// the owner-driven identity-link flow, so the security properties are
// identical. Nothing here auto-approves: every grant is an explicit owner
// decision, audit-logged as a member.added event.
//
// The module is storage-agnostic: it takes the RoomStore (for the db handle,
// transactions, auth, and the identities helper) and exports its schema for
// store.mjs to apply, following the agent-identities.mjs pattern.

import { randomUUID, createHash } from "node:crypto";
import { createRateLimiter } from "./identity-ratelimit.mjs";
// RC-2026-09-19-071 (QAJ-006): a new access request appends an
// access.requested room event so the request is timeline-visible and drives
// an owner notification. These imports follow the agent-invites.mjs
// precedent (same Workers bundle, same optional list in
// scripts/runtime-package.mjs).
import { event, EVENT_TYPES as T, isRoomArchived } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";

// Local ServiceError (mirrors server/store.mjs). We avoid importing from
// store.mjs here to break the circular dependency for the Workers bundle:
// store.mjs imports this module, so this module cannot import from store.mjs
// at the top level without esbuild failing on the cycle.
class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Room permission vocabulary, mirrored from PERMISSIONS in src/events.js
// (same Workers-bundle reason as above). access requests and approvals are
// validated against this so an invalid name fails fast with a 422 that
// teaches the vocabulary, instead of pending and failing opaquely later.
// tests/access-requests.test.js asserts this stays in sync with PERMISSIONS.
export const ACCESS_REQUEST_PERMISSIONS = Object.freeze(
  ["steer", "decide", "manage_members", "manage_claims", "accept_work", "complete_work", "verify", "write_external", "invite_member"]);

export const accessRequestSchema = `
  CREATE TABLE IF NOT EXISTS access_requests (
    request_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    requested_permissions TEXT NOT NULL,
    note TEXT,
    referred_by TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    decision_note TEXT
  );
  CREATE INDEX IF NOT EXISTS access_requests_room ON access_requests(room_id, status);
  CREATE INDEX IF NOT EXISTS access_requests_identity ON access_requests(identity_id);
`;

const STATUSES = ["pending", "approved", "denied", "expired", "cancelled"];
const DECISIONS = ["approve", "deny"];
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// An identity may hold at most this many pending requests per room.
export const MAX_PENDING_PER_IDENTITY_ROOM = 5;
// Requests expire after this long without a decision.
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const rowToRequest = row => row ? Object.freeze({
  requestId: row.request_id,
  roomId: row.room_id,
  identityId: row.identity_id,
  displayName: row.display_name,
  requestedPermissions: JSON.parse(row.requested_permissions),
  note: row.note,
  // "Who referred you?" free text, answered at request time; resolved to a
  // member id only at approval, so the stored text is never an attribution.
  referredBy: row.referred_by ?? null,
  status: row.status,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
  decisionNote: row.decision_note
}) : null;

// Mirrors the projection compaction in store.mjs / agent-invites.mjs: strip
// replay-only caches before persisting the projection.
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
// Bounded pilot capacity, mirroring agent-invites.mjs (PILOT_LIMITS in
// store.mjs cannot be imported here without a circular dependency).
const MAX_ROOM_EVENTS = 10000;
const MAX_PROJECTION_BYTES = 4 * 1024 * 1024;

export class AccessRequests {
  constructor(store, { rateLimiter } = {}) {
    this.store = store;
    this.db = store.db;
    // Separate bucket from general API use: requesting access is rare and
    // sensitive. 5 requests per hour per identity is generous for humans
    // and tight enough to blunt enumeration.
    this.rateLimiter = rateLimiter ?? createRateLimiter({ capacity: 5, refillPerSecond: 5 / 3600 });
  }

  // Unauthenticated: an identity (not yet a member) asks to join a room.
  // requestId is the caller's idempotency key: retries with the same id
  // return the original request instead of creating a duplicate.
  request(roomId, { identityId, displayName, requestedPermissions, note, referredBy, requestId }) {
    if (typeof roomId !== "string" || !roomId) fail(422, "invalid_request", "roomId is required");
    if (typeof identityId !== "string" || !identityId) fail(422, "invalid_request", "identityId is required");
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 80) fail(422, "invalid_request", "displayName must be 1-80 characters");
    if (!Array.isArray(requestedPermissions)
      || !requestedPermissions.every(p => typeof p === "string" && p.length > 0 && p.length <= 64)) {
      fail(422, "invalid_request", "requestedPermissions must be an array of permission strings; empty requests read/chat access");
    }
    // RC-2026-09-18-022: validate names up front. An unknown name (e.g.
    // "read") used to pend and fail opaquely at approval; now the 422
    // teaches the vocabulary immediately.
    if (!requestedPermissions.every(p => ACCESS_REQUEST_PERMISSIONS.includes(p))) {
      fail(422, "invalid_request",
        `requestedPermissions must be room permissions (valid: ${ACCESS_REQUEST_PERMISSIONS.join(", ")})`);
    }
    // RC-2026-09-18-025: explicit null is treated as omitted ("no note"),
    // since JSON clients naturally send null for "no note".
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 500)) {
      fail(422, "invalid_request", "note must be text of at most 500 characters");
    }
    // "Who referred you?" — optional free text, matched against member
    // display names at approval time. Never blocks the join: unmatched or
    // ambiguous answers simply attribute nothing.
    if (referredBy !== undefined && referredBy !== null && (typeof referredBy !== "string" || referredBy.length > 80)) {
      fail(422, "invalid_request", "referredBy must be text of at most 80 characters");
    }
    const rid = requestId ?? `ar_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    if (!REQUEST_ID_PATTERN.test(rid)) fail(422, "invalid_request", "requestId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");

    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(rid);
      if (existing) {
        // Idempotent retry: only the original identity may observe it.
        if (existing.identity_id !== identityId) fail(409, "request_conflict", "requestId is already in use");
        return rowToRequest(existing);
      }
      // The identity must exist (minted via identity-create). We do not
      // reveal anything else: a missing identity and a bad room look the
      // same to the caller.
      const identity = this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=?").get(identityId);
      if (!identity) fail(404, "not_found", "No such room or identity");
      // Past the idempotent retry and past the existence check, deliberately.
      // identityId is caller-supplied on an unauthenticated route, so keying
      // the limiter on it before proving the identity exists let one address
      // void the documented 5/hour bound by changing a character per request,
      // and allocated a bucket per made-up value that was never released.
      // Keyed here, the space is bounded by the identities table. A retry that
      // returns the original request creates nothing, so it costs nothing.
      const limit = this.rateLimiter.check(`access-request:${identityId}`);
      if (!limit.allowed) fail(429, "rate_limited", limit.message);
      const roomExists = this.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId);
      if (!roomExists) fail(404, "not_found", "No such room or identity");
      // Already a member? Then there is nothing to request.
      const linked = this.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (linked) fail(409, "already_member", "This identity is already linked to this room");
      const pending = this.db.prepare(
        "SELECT count(*) AS n FROM access_requests WHERE room_id=? AND identity_id=? AND status='pending'").get(roomId, identityId).n;
      if (pending >= MAX_PENDING_PER_IDENTITY_ROOM) {
        fail(409, "too_many_requests", `At most ${MAX_PENDING_PER_IDENTITY_ROOM} pending requests per room`);
      }
      const now = this.store.now();
      this.db.prepare(`INSERT INTO access_requests(
          request_id, room_id, identity_id, display_name, requested_permissions,
          note, referred_by, status, created_at) VALUES(?,?,?,?,?,?,?, 'pending', ?)`)
        .run(rid, roomId, identityId, name, JSON.stringify(requestedPermissions),
          note?.trim() || null, typeof referredBy === "string" && referredBy.trim() ? referredBy.trim() : null, now);
      // RC-2026-09-19-071 (QAJ-006): the arrival is timeline-visible and
      // drives the owner's notification feed. Same transaction as the
      // insert, so a request is never recorded without its event. The
      // idempotent-retry branch above returns before this point, so a
      // retry never emits a duplicate.
      this.emitAccessRequested(roomId, {
        requestId: rid, identityId, displayName: name,
        requestedPermissions, note: note?.trim() || null, at: now,
      });
      return rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(rid));
    });
  }

  // Append the access.requested room event. The requester is not a member,
  // so they are the actorId as their identity. Archived rooms keep the old
  // behavior (request recorded, no timeline event — there is no live
  // timeline audience to notify).
  emitAccessRequested(roomId, { requestId, identityId, displayName, requestedPermissions, note, at }) {
    const room = this.store.room(roomId);
    if (isRoomArchived(room.state)) return;
    if (room.sequence >= MAX_ROOM_EVENTS) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
    const incoming = event({
      id: randomUUID(),
      idempotencyKey: createHash("sha256").update(`access-request:${requestId}`).digest("hex"),
      type: T.ACCESS_REQUESTED,
      roomId,
      actorId: identityId,
      at: new Date(at).toISOString(),
      data: {
        requestId,
        identityId,
        displayName,
        // The permissions the requester asked for (the owner chooses the
        // final grant at decision time). Keyed `permissions` — not
        // `requestedPermissions` — because validateEnvelope only allows
        // array values for a fixed set of data keys.
        permissions: [...requestedPermissions],
        note,
      },
    });
    let state;
    try { state = compactState(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
    catch (error) { fail(409, "access_rejected", error.message); }
    const projection = JSON.stringify(state);
    if (Buffer.byteLength(projection) > MAX_PROJECTION_BYTES) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
  }

  // Identity-scoped read: the requesting identity checks its own request.
  // Anyone else gets 404, so pending requests are not enumerable.
  status(requestId, identityId) {
    const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId);
    if (!row || row.identity_id !== identityId) fail(404, "not_found", "No such join request");
    return rowToRequest(this.maybeExpire(row));
  }

  // RC-2026-09-18-038: membership administration is the caller's own
  // manage_members permission OR an owner grant on their agent identity
  // (server/membership-delegation.mjs). Agents without either are denied
  // exactly as before.
  #requireMembershipAdministration(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!this.store.delegation.canAdministerMembership(authority, auth, roomId)) {
      fail(403, "access_denied", "Membership administration grant required");
    }
    return { auth, authority };
  }

  // Owner-only: list requests for a room, optionally filtered by status.
  list(token, roomId, { status = "pending" } = {}, expectedSessionBinding = null) {
    this.#requireMembershipAdministration(token, roomId, expectedSessionBinding);
    if (!STATUSES.includes(status)) fail(422, "invalid_request", `status must be one of ${STATUSES.join(", ")}`);
    this.expireOld(roomId);
    const rows = this.db.prepare(
      "SELECT * FROM access_requests WHERE room_id=? AND status=? ORDER BY created_at ASC").all(roomId, status);
    return Object.freeze(rows.map(rowToRequest));
  }

  // Owner or membership-administration delegate (RC-2026-09-18-038):
  // approve or deny. Approval links the identity via the same
  // AgentIdentities.link() path as the manual owner flow.
  decide(token, roomId, requestId, { decision, permissions, note } = {}, expectedSessionBinding = null) {
    if (!DECISIONS.includes(decision)) fail(422, "invalid_request", "decision must be 'approve' or 'deny'");
    const { auth, authority } = this.#requireMembershipAdministration(token, roomId, expectedSessionBinding);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=? AND room_id=?").get(requestId, roomId);
      if (!row) fail(404, "not_found", "No such join request");
      const live = this.maybeExpire(row);
      if (live.status !== "pending") fail(409, "already_decided", `Request is already ${live.status}`);
      const now = this.store.now();
      if (decision === "deny") {
        // RC-2026-09-18-025: explicit null treated as omitted, same as request().
        if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 500)) {
          fail(422, "invalid_request", "note must be text of at most 500 characters");
        }
        this.db.prepare("UPDATE access_requests SET status='denied', decided_at=?, decided_by=?, decision_note=? WHERE request_id=?")
          .run(now, auth.member.id, note?.trim() || null, requestId);
        return rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
      }
      // Approve: the owner chooses the final permissions (never more than
      // the agent asked for is not enforced — the owner is sovereign — but
      // the request records what was asked).
      const grants = permissions === undefined ? JSON.parse(row.requested_permissions) : permissions;
      // RC-2026-09-18-022: the approval grant is validated too, so a
      // hand-written approval can never mint a member with nonsense
      // permissions. (Requests validated at request() time already pass.)
      if (!Array.isArray(grants) || !grants.every(p => typeof p === "string" && ACCESS_REQUEST_PERMISSIONS.includes(p))) {
        fail(422, "invalid_request",
          `permissions must be room permissions (valid: ${ACCESS_REQUEST_PERMISSIONS.join(", ")})`);
      }
      // RC-2026-09-18-038: a delegate acting on an owner grant may admit
      // members but may never confer manage_members — that would make the
      // grant transitive. The owner (or a member already holding
      // manage_members) remains sovereign.
      if (grants.includes("manage_members") && !this.store.delegation.mayConferManageMembers(authority, auth)) {
        fail(403, "access_denied", "Delegated membership administration cannot grant manage_members");
      }
      const identities = this.store.identities;
      // Referral attribution: match the "who referred you?" text against
      // member display names. A unique match attributes the join; anything
      // else joins with no referrer and the approval proceeds unchanged.
      const referrerMemberId = this.store.referrals.matchReferrer(roomId, row.referred_by);
      const linked = identities.link(token, roomId, {
        identityId: row.identity_id,
        displayName: row.display_name,
        permissions: grants,
        ...(referrerMemberId ? { referredBy: referrerMemberId } : {})
      }, expectedSessionBinding);
      this.db.prepare("UPDATE access_requests SET status='approved', decided_at=?, decided_by=? WHERE request_id=?")
        .run(now, auth.member.id, requestId);
      // Journal the completed referral in the same transaction, after the
      // new member exists. Exactly-once per referee via the referrals
      // primary key, so a retried approval cannot double-count.
      if (referrerMemberId && referrerMemberId !== linked.memberId) {
        this.store.referrals.record({ roomId, referrerMemberId, refereeMemberId: linked.memberId, via: "request", at: now });
      }
      const updated = rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
      // RC-2026-09-18-036: name the actual grant — the response used to echo
      // only requestedPermissions, so when the owner narrowed the grant the
      // effective permissions were invisible in the 200. The next[] names
      // the owner's moves now that the member is in the room.
      return Object.freeze({
        ...updated,
        memberId: linked.memberId,
        grantedPermissions: Object.freeze([...grants]),
        next: Object.freeze([
          Object.freeze({ action: "say-hello", method: "POST", path: `/api/rooms/${encodeURIComponent(roomId)}/commands`,
            description: `Post a welcome message for ${row.display_name}: send { id: <uuid>, type: "message.posted", data: { messageId: <uuid>, body: "hello", toMemberId: "${linked.memberId}" } } to DM the new member directly.` }),
          Object.freeze({ action: "see-new-member", method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/presence`,
            description: "Confirm the new member in the room's member list, with their granted permissions." }),
        ]),
      });
    });
  }

  // The requester withdraws a still-pending request. A different identity gets
  // the same 404 as status(), so this is not an enumeration or admin path.
  // A repeated cancel returns the cancelled row so a lost response can retry.
  cancel(requestId, identityId) {
    if (typeof identityId !== "string" || !identityId) fail(422, "invalid_request", "identityId is required");
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId);
      if (!row || row.identity_id !== identityId) fail(404, "not_found", "No such join request");
      const live = this.maybeExpire(row);
      if (live.status === "cancelled") return rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
      if (live.status !== "pending") fail(409, "already_decided", `Request is already ${live.status}`);
      const now = this.store.now();
      this.db.prepare("UPDATE access_requests SET status='cancelled', decided_at=?, decision_note=? WHERE request_id=?")
        .run(now, "withdrawn by requester", requestId);
      return rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
    });
  }

  // Mark a single row expired if past TTL; returns the (possibly updated) row.
  maybeExpire(row) {
    if (row.status === "pending" && this.store.now() - row.created_at > REQUEST_TTL_MS) {
      this.db.prepare("UPDATE access_requests SET status='expired' WHERE request_id=?").run(row.request_id);
      return { ...row, status: "expired" };
    }
    return row;
  }

  expireOld(roomId) {
    const cutoff = this.store.now() - REQUEST_TTL_MS;
    this.db.prepare("UPDATE access_requests SET status='expired' WHERE room_id=? AND status='pending' AND created_at<?")
      .run(roomId, cutoff);
  }
}
