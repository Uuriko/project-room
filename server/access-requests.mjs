// Self-serve agent access requests.
//
// An agent that minted an identity (server/agent-identities.mjs) but has no
// room membership can request access to a room. Existing members may also
// request additional permissions, which always require a reviewed decision.
// The request sits in a
// pending queue; the room owner — or an agent identity the owner has
// explicitly granted membership administration
// (server/membership-delegation.mjs) — approves or denies it. Approval links the
// identity as a room member via AgentIdentities.link() — the same path as
// the owner-driven identity-link flow, so the security properties are
// identical.
//
// A room may also configure an auto-approve rule (room_access_auto_approve):
// a standing list of permissions the room admits without a human in the
// loop. An incoming request whose requested permissions are a non-empty
// subset of the configured set is approved and linked inline, synchronously,
// in the same call that files it; anything else stays pending for the owner
// queue. Auto-approve can never confer admin powers, external-write access,
// or admission authority (manage_members, decide, manage_claims,
// write_external, and invite_member are rejected from the config), never fires in
// rooms that require verified agents, and stops admitting the moment its
// authorizing configurer loses membership administration — fail-closed to
// pending. Auto-approvals are audit-logged as member.added events whose
// request row carries decided_by='auto-approve'.
//
// The module is storage-agnostic: it takes the RoomStore (for the db handle,
// transactions, auth, and the identities helper) and exports its schema for
// store.mjs to apply, following the agent-identities.mjs pattern.

import { randomUUID, createHash } from "node:crypto";
import { MemberPermissionRequests, permissionRequestContents } from "./member-permission-requests.mjs";
import { createRateLimiter } from "./identity-ratelimit.mjs";
// RC-2026-09-19-071 (QAJ-006): a new access request appends an
// access.requested room event so the request is timeline-visible and drives
// an owner notification. These imports follow the agent-invites.mjs
// precedent (same Workers bundle, same optional list in
// scripts/runtime-package.mjs).
import { event, EVENT_TYPES as T, isRoomArchived, memberCan } from "../src/events.js";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { assertMemberDisplayNameAvailable, checkAgentDisplayName } from "./display-name-guard.mjs";
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
  -- Self-serve admission (RC-2026-09-29-3603): a room's standing auto-approve
  -- rule. When set, incoming requests whose permissions are a non-empty subset
  -- of this list are approved and linked inline, with no human in the loop.
  -- Registered in server/writer-fence.mjs unfencedAdditiveTables.
  CREATE TABLE IF NOT EXISTS room_access_auto_approve (
    room_id TEXT PRIMARY KEY,
    permissions TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );
`;

const STATUSES = ["pending", "approved", "denied", "expired", "cancelled"];
// Older writers only decide raw 'pending' rows. This distinct stored status
// fences upgrades on rollback, including approvals with explicit permissions.
// Public callers still see 'pending'; direct identity grants intentionally do
// not settle these rows, because changed membership requires a fresh review.
const UPGRADE_PENDING_STATUS = "pending_upgrade";
const isPending = status => status === "pending" || status === UPGRADE_PENDING_STATUS;
const DECISIONS = ["approve", "deny"];
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// An identity may hold at most this many pending requests per room.
export const MAX_PENDING_PER_IDENTITY_ROOM = 5;
// Requests expire after this long without a decision.
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Legacy admission rows contain a permission array. Upgrade intent lives in
// the request row, not only in the replaceable event journal: restoring room
// history must never reinterpret a stale upgrade as a fresh admission.
const requestContents = permissionRequestContents;

const rowToRequest = row => row ? Object.freeze({
  requestId: row.request_id,
  roomId: row.room_id,
  identityId: requestContents(row).upgrade?.principalKind === "room-member" ? null : row.identity_id,
  kind: requestContents(row).upgrade ? "permissions" : "join",
  ...(requestContents(row).upgrade ? { memberId: requestContents(row).upgrade.memberId } : {}),
  displayName: row.display_name,
  requestedPermissions: requestContents(row).permissions,
  note: row.note,
  // "Who referred you?" free text, answered at request time; resolved to a
  // member id only at approval, so the stored text is never an attribution.
  referredBy: row.referred_by ?? null,
  status: row.status === UPGRADE_PENDING_STATUS ? "pending" : row.status,
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
const MAX_MEMBERS_PER_ROOM = 100;
const countActiveMembers = members =>
  Object.values(members ?? {}).filter(member => member?.active !== false).length;

// Permissions an auto-approve config may never include. A standing rule that
// admits guests must not be able to mint managers, deciders, claim arbiters,
// external-write access, or further admission authority: the guest tier never
// gets admin powers. write_external gates write-mode work items (the room's
// external-write boundary); invite_member lets a holder mint invite codes for
// other identities (transitive admission the owner's rule never granted).
// Kill criterion from the safety review — rejected with a teaching 422 at
// config time.
const AUTO_APPROVE_FORBIDDEN_PERMISSIONS = Object.freeze(
  ["manage_members", "decide", "manage_claims", "write_external", "invite_member"]);

export class AccessRequests {
  constructor(store, { rateLimiter } = {}) {
    this.store = store;
    this.db = store.db;
    this.memberPermissions = new MemberPermissionRequests(this, MAX_PENDING_PER_IDENTITY_ROOM);
    // Separate bucket from general API use: requesting access is rare and
    // sensitive. 5 requests per hour per identity is generous for humans
    // and tight enough to blunt enumeration.
    this.rateLimiter = rateLimiter ?? createRateLimiter({ capacity: 5, refillPerSecond: 5 / 3600 });
  }

  toRequest(row) { return rowToRequest(row); }

  requestForMember(token, roomId, input, binding = null) {
    return this.memberPermissions.request(token, roomId, input, binding);
  }

  // Admission is public. Upgrades require the current identity secret as
  // proof of the requester's identity, then an authorized reviewed decision.
  // requestId is the caller's idempotency key: retries with the same id
  // return the original request instead of creating a duplicate.
  request(roomId, { identityId, displayName, requestedPermissions, note, referredBy, requestId }, secret = null) {
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
        if (this.upgradeBasis(existing)) this.store.identities.authenticateIdentitySecret(identityId, secret);
        // A retried auto-approval returns the approval record (member id +
        // grant), not just the row — so a lost response can recover the
        // membership the call created.
        if (existing.status === "approved" && existing.decided_by === "auto-approve") {
          const link = this.db.prepare(
            "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?"
          ).get(existing.room_id, existing.identity_id);
          if (link) return this.autoApproveResponse(rowToRequest(existing), link.memberId, requestContents(existing).permissions);
        }
        const retryLive = rowToRequest(existing);
        if (retryLive.status === "pending") {
          return Object.freeze({ ...retryLive, next: this.pendingNext(rid, identityId) });
        }
        return retryLive;
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
      const linked = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (linked) {
        // Preserve the public already-member response without exposing the
        // member name or which permissions it holds to an anonymous probe.
        if (!secret) fail(409, "already_member", "This identity is already linked to this room; present its current identity secret as Bearer to request additional permissions");
        this.store.identities.authenticateIdentitySecret(identityId, secret);
      }
      // Invalid upgrade proofs must not spend the real holder's request quota.
      const limit = this.rateLimiter.check(`access-request:${identityId}`);
      if (!limit.allowed) fail(429, "rate_limited", limit.message);
      const roomExists = this.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId);
      if (!roomExists) fail(404, "not_found", "No such room or identity");
      const room = this.store.room(roomId);
      const member = linked && Object.hasOwn(room.state.members, linked.memberId) ? room.state.members[linked.memberId] : null;
      if (linked) {
        if (!member || member.active === false || member.identityId !== identityId || this.store.identities.secretRevoked(identityId)) {
          fail(409, "stale_membership", "Current active membership required; ask a room owner to review access");
        }
        if (requestedPermissions.every(permission => member.permissions.includes(permission))) {
          fail(409, "already_member", "This identity is already linked to this room with the requested permissions");
        }
        if (isRoomArchived(room.state)) fail(409, "room_archived", "This room is archived; access cannot be upgraded");
      }
      const pending = this.db.prepare(
        "SELECT count(*) AS n FROM access_requests WHERE room_id=? AND identity_id=? AND status IN ('pending', 'pending_upgrade')").get(roomId, identityId).n;
      if (pending >= MAX_PENDING_PER_IDENTITY_ROOM) {
        fail(409, "too_many_requests", `At most ${MAX_PENDING_PER_IDENTITY_ROOM} pending requests per room`);
      }
      // The requested name is the member name an approval will store. Refuse
      // it before the request or its timeline event is written.
      // An upgrade cannot rename or impersonate another member. Use the
      // linked member's current name, rather than checking it against itself.
      const requestName = member ? member.displayName : name;
      if (!member) assertMemberDisplayNameAvailable(requestName, room.state.members);
      const now = this.store.now();
      const storedPermissions = member ? { version: 1, kind: "permission-upgrade",
        permissions: requestedPermissions, memberId: member.id, memberRevision: member.revision } : requestedPermissions;
      this.db.prepare(`INSERT INTO access_requests(
          request_id, room_id, identity_id, display_name, requested_permissions,
          note, referred_by, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(rid, roomId, identityId, requestName, JSON.stringify(storedPermissions),
          note?.trim() || null, typeof referredBy === "string" && referredBy.trim() ? referredBy.trim() : null,
          member ? UPGRADE_PENDING_STATUS : "pending", now);
      // RC-2026-09-19-071 (QAJ-006): the arrival is timeline-visible and
      // drives the owner's notification feed. Same transaction as the
      // insert, so a request is never recorded without its event. The
      // idempotent-retry branch above returns before this point, so a
      // retry never emits a duplicate.
      this.emitAccessRequested(roomId, {
        requestId: rid, identityId, displayName: requestName,
        requestedPermissions, note: note?.trim() || null, at: now,
        upgradeMember: member,
      });
      // Self-serve admission (RC-2026-09-29-3603): rooms with an auto-approve
      // rule admit matching requests inline, in the same transaction.
      // Anything the rule does not cover stays pending for the owner queue —
      // and a pending request never sits silent: when a configured rule did
      // not fire, the response says why (the HTTP layer also links poll-status
      // next[]).
      const attempt = this.tryAutoApprove(roomId, rid);
      const live = rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(rid));
      if (attempt.approved) return attempt.response;
      // Pending: the response carries poll-status guidance (see
      // pendingNext()) so the requester is never left guessing. The HTTP
      // wrapper reuses this next[] rather than rebuilding it.
      const guidance = this.pendingNext(rid, identityId);
      if (attempt.pendingNote) return Object.freeze({ ...live, pendingNote: attempt.pendingNote, next: guidance });
      return Object.freeze({ ...live, next: guidance });
    });
  }

  // Append the access.requested room event. The requester is not a member,
  // so they are the actorId as their identity. Archived rooms keep the old
  // behavior (request recorded, no timeline event — there is no live
  // timeline audience to notify).
  emitAccessRequested(roomId, { requestId, identityId, displayName, requestedPermissions, note, at, upgradeMember = null, identityScope = "global" }) {
    const room = this.store.room(roomId);
    if (isRoomArchived(room.state)) return;
    if (room.sequence >= MAX_ROOM_EVENTS) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
    const requestKey = createHash("sha256").update(`access-request:${requestId}`).digest("hex");
    if (upgradeMember && this.db.prepare("SELECT 1 FROM events WHERE id=?").get(requestKey)) {
      fail(409, "request_conflict", "requestId conflicts with an existing room event; use a new requestId");
    }
    const incoming = event({
      // Only upgrade events use a deterministic ID, so their review basis
      // can be read through the existing UNIQUE events.id index.
      id: upgradeMember ? requestKey : randomUUID(),
      idempotencyKey: requestKey,
      type: T.ACCESS_REQUESTED,
      roomId,
      actorId: identityId,
      at: new Date(at).toISOString(),
      data: {
        requestId,
        identityId,
        // Preserve the ordinary join event shape; only permission requests
        // need the additional member/principal discriminator.
        ...(upgradeMember ? { identityScope, requestKind: "permissions", requesterMemberId: upgradeMember.id } : {}),
        displayName,
        // The permissions the requester asked for (the owner chooses the
        // final grant at decision time). Keyed `permissions` — not
        // `requestedPermissions` — because validateEnvelope only allows
        // array values for a fixed set of data keys.
        permissions: [...requestedPermissions],
        note,
        // Audit the exact membership revision. The request row separately
        // persists this intent so replacing history cannot erase the binding.
        ...(upgradeMember ? { upgradeMemberId: upgradeMember.id, expectedMemberRevision: upgradeMember.revision } : {}),
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

  // The durable row distinguishes upgrades from legacy admission requests,
  // including when an import has replaced their original request event.
  upgradeBasis(row) {
    return requestContents(row).upgrade;
  }

  // RC-2026-09-29-3603: setting a standing admission rule requires actual
  // manage_members — deliberately stricter than #requireMembershipAdministration.
  // A membership-administration delegate may decide individual requests, but a
  // standing rule that admits without review must not be settable by a grant
  // that is itself delegated (that would make the grant transitive).
  #requireManageMembers(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    let allowed = false;
    try { allowed = memberCan(authority, auth.member.id, "manage_members"); }
    catch { allowed = false; }
    if (!allowed) fail(403, "access_denied", "manage_members required");
    return { auth, authority };
  }

  // Internal read of the room's auto-approve rule. Returns
  // { permissions, updatedAt, updatedBy } or null when the room has no rule.
  getAutoApproveConfig(roomId) {
    const row = this.db.prepare("SELECT * FROM room_access_auto_approve WHERE room_id=?").get(roomId);
    return row ? { permissions: JSON.parse(row.permissions), updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
  }

  // Owner-only read: the room's auto-approve rule, or null.
  getAutoApprove(token, roomId, expectedSessionBinding = null) {
    this.#requireManageMembers(token, roomId, expectedSessionBinding);
    const config = this.getAutoApproveConfig(roomId);
    return Object.freeze({
      roomId,
      autoApprove: config ? Object.freeze({
        permissions: Object.freeze([...config.permissions]),
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy,
      }) : null,
    });
  }

  // Owner-only write: set or replace the room's auto-approve rule. An empty
  // permission list deletes the rule (auto-approve off).
  setAutoApprove(token, roomId, { permissions } = {}, expectedSessionBinding = null) {
    const { auth } = this.#requireManageMembers(token, roomId, expectedSessionBinding);
    // A standing admission rule is a membership write: the read-only autonomy
    // tier cannot set one, even holding manage_members (issue #996).
    enforceAutonomyTierForAction({ db: this.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "access_auto_approve", fail });
    if (!Array.isArray(permissions)) fail(422, "invalid_request", "permissions must be an array of permission strings; empty disables auto-approve");
    return this.store.transaction(() => {
      if (permissions.length === 0) {
        this.db.prepare("DELETE FROM room_access_auto_approve WHERE room_id=?").run(roomId);
        return Object.freeze({ roomId, autoApprove: null });
      }
      if (!permissions.every(p => typeof p === "string" && ACCESS_REQUEST_PERMISSIONS.includes(p))) {
        fail(422, "invalid_request",
          `permissions must be room permissions (valid: ${ACCESS_REQUEST_PERMISSIONS.join(", ")})`);
      }
      if (new Set(permissions).size !== permissions.length) fail(422, "invalid_request", "permissions must not repeat");
      const forbidden = permissions.filter(p => AUTO_APPROVE_FORBIDDEN_PERMISSIONS.includes(p));
      if (forbidden.length) {
        fail(422, "invalid_request",
          `auto-approve may never grant elevated permissions (${forbidden.join(", ")}): a standing rule that admits guests cannot mint admin powers, external-write access, claim arbitration, or further admission authority`);
      }
      const now = this.store.now();
      this.db.prepare(`INSERT INTO room_access_auto_approve(room_id, permissions, updated_at, updated_by)
        VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET
          permissions=excluded.permissions, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(roomId, JSON.stringify(permissions), now, auth.member.id);
      return Object.freeze({
        roomId,
        autoApprove: Object.freeze({
          permissions: Object.freeze([...permissions]),
          updatedAt: now,
          updatedBy: auth.member.id,
        }),
      });
    });
  }

  // Self-serve admission: attempt to approve and link a pending request under
  // the room's auto-approve rule. Called inside request()'s transaction, after
  // the request row and its access.requested event are recorded.
  //
  // The grant path is internal by design (agent-invites.mjs redeem
  // precedent): it builds the member.added event directly and persists it
  // through applyEventWithGrowth, instead of calling AgentIdentities.link(),
  // which requires the requester's credential — an auto-approve has no
  // business holding that. The rule's author (updated_by) is the auditable
  // actor on the event and is named in the decision note; the request row
  // carries decided_by='auto-approve'.
  //
  // Returns { approved: true, response } or { approved: false, pendingNote }.
  // pendingNote explains why a configured rule did not fire; it is null when
  // the room has no rule, preserving the existing silent-pending behavior.
  tryAutoApprove(roomId, requestId) {
    const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId);
    if (!row || !isPending(row.status) || row.room_id !== roomId) return { approved: false, pendingNote: null };
    if (this.upgradeBasis(row)) return { approved: false, pendingNote:
      "Additional permissions for an existing member require an authorized review; this request waits for a decision." };
    const config = this.getAutoApproveConfig(row.room_id);
    if (!config) return { approved: false, pendingNote: null };
    const requested = requestContents(row).permissions;
    if (!requested.length || !requested.every(p => config.permissions.includes(p))) {
      return { approved: false, pendingNote:
        `This room auto-approves ${config.permissions.join(", ")}; the requested ${requested.join(", ") || "read/chat access"} is outside the rule, so it waits for an owner decision.` };
    }
    // Verified-only rooms never auto-approve: the identity must be verified
    // first. Mirrors the AgentIdentities.link() gate exactly.
    const plugin = this.store.agentPlugin;
    if (plugin && plugin.roomVerificationPolicy(row.room_id).requireVerified
        && plugin.verificationLevel(row.identity_id) !== "verified") {
      return { approved: false, pendingNote:
        "This room only admits verified agents. Ask a room owner to verify the identity; the request stays pending meanwhile." };
    }
    // The rule author's authority is re-checked at approval time: a standing
    // rule whose author lost membership administration stops admitting.
    // Fail-closed to pending — the owner queue is the safe default.
    let authorizerActive = false;
    try { authorizerActive = memberCan(this.store.room(row.room_id).state, config.updatedBy, "manage_members"); }
    catch { authorizerActive = false; }
    if (!authorizerActive) {
      return { approved: false, pendingNote:
        "This room's auto-approve rule is suspended: its author no longer holds membership administration. The request waits for an owner decision." };
    }
    const room = this.store.room(row.room_id);
    if (isRoomArchived(room.state)) {
      return { approved: false, pendingNote: "This room is archived; new admissions wait for an owner decision." };
    }
    // Bounded pilot capacity, mirroring the invite-redeem guard.
    if (room.sequence + 1 >= MAX_ROOM_EVENTS || countActiveMembers(room.state.members) >= MAX_MEMBERS_PER_ROOM) {
      return { approved: false, pendingNote: "This room is at pilot capacity; the request waits for an owner decision." };
    }
    // Reserved, duplicate, confusable, and control-character names never
    // become a member here. A name that fails only the older mixed-script
    // check still waits for the owner, as before.
    try {
      assertMemberDisplayNameAvailable(row.display_name, room.state.members);
    } catch (error) {
      if (error.code !== "display_name_unavailable") throw error;
      return { approved: false, pendingNote: "That display name is unavailable, so the request waits for an owner decision." };
    }
    // Deceptive-name guard, same as AgentIdentities.link(): a confusing or
    // duplicate name never auto-admits — it waits for owner review.
    const canonical = value => value.trim().replace(/\p{White_Space}+/gu, " ").toLowerCase();
    const activeNames = Object.values(room.state.members)
      .filter(member => member.active !== false && member.id !== row.identity_id
        && canonical(member.displayName) !== canonical(row.display_name))
      .map(member => ({ memberId: member.id, displayName: member.displayName }));
    const checked = checkAgentDisplayName(row.display_name, { activeNames });
    if (!checked.safe) {
      return { approved: false, pendingNote:
        `The display name was not auto-approved (${checked.reason}); it waits for an owner decision.` };
    }
    const now = this.store.now();
    // Referral attribution: match the "who referred you?" text against member
    // display names, exactly as decide() does. Unmatched text joins with no
    // referrer and never blocks the admission.
    const referrerMemberId = this.store.referrals.matchReferrer(row.room_id, row.referred_by);
    const incoming = event({
      id: randomUUID(),
      idempotencyKey: createHash("sha256").update(`access-request:auto-approve:${requestId}`).digest("hex"),
      type: T.MEMBER_ADDED,
      roomId: row.room_id,
      actorId: config.updatedBy,
      at: new Date(now).toISOString(),
      data: {
        memberId: row.identity_id,
        displayName: row.display_name,
        kind: "agent",
        permissions: [...requested],
        identityId: row.identity_id,
        ...(referrerMemberId ? { referredBy: referrerMemberId } : {}),
      },
    });
    let state;
    try { state = compactState(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
    catch (error) {
      return { approved: false, pendingNote: `Auto-approve was rejected (${error.message}); the request waits for an owner decision.` };
    }
    const projection = JSON.stringify(state);
    if (Buffer.byteLength(projection) > MAX_PROJECTION_BYTES) {
      return { approved: false, pendingNote: "Room projection limit reached; the request waits for an owner decision." };
    }
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, incoming.id, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
    this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(row.room_id, row.identity_id, row.identity_id, now);
    if (referrerMemberId && referrerMemberId !== row.identity_id) {
      this.store.referrals.record({ roomId: row.room_id, referrerMemberId, refereeMemberId: row.identity_id, via: "request", at: now });
    }
    this.db.prepare("UPDATE access_requests SET status='approved', decided_at=?, decided_by='auto-approve', decision_note=? WHERE request_id=?")
      .run(now, `auto-approved under standing rule set by ${config.updatedBy}`, requestId);
    const updated = rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
    return { approved: true, response: this.autoApproveResponse(updated, row.identity_id, requested) };
  }

  // Approval-shaped response shared by tryAutoApprove and the idempotent
  // retry: the request row plus the membership it created, and the new
  // member's first moves.
  autoApproveResponse(row, memberId, grants) {
    return Object.freeze({
      ...row,
      memberId,
      grantedPermissions: Object.freeze([...grants]),
      next: Object.freeze([
        Object.freeze({ action: "orient", method: "GET", path: `/api/rooms/${encodeURIComponent(row.roomId)}/orient`,
          description: "You are a member now. Orient to the room: members, open work items, and how to claim work." }),
        Object.freeze({ action: "see-membership", method: "GET", path: `/api/rooms/${encodeURIComponent(row.roomId)}/presence`,
          description: "Confirm your membership and granted permissions in the room's member list." }),
      ]),
    });
  }

  // Pending-response guidance (RC-2026-09-29-3603): a pending request never
  // sits silent. The poll-status next[] lives here at the service level so
  // every caller — HTTP, the enroll route's inline room join, the plug-in
  // route — gets the same guidance; the HTTP wrapper reuses it instead of
  // rebuilding it.
  pendingNext(requestId, identityId) {
    return Object.freeze([
      Object.freeze({ action: "poll-status", method: "GET",
        path: `/api/access-requests/${encodeURIComponent(requestId)}?identityId=${encodeURIComponent(identityId)}`,
        description: `Poll this path with your identityId to learn the owner's decision. Existing-member upgrades also require your current identity secret as Bearer. Requests expire undecided after ${REQUEST_TTL_MS / 86400000} days.` }),
      Object.freeze({ action: "cancel-request", method: "POST",
        path: `/api/access-requests/${encodeURIComponent(requestId)}`,
        description: "Withdraw this pending request. Send { identityId } with your identity's current secret as the Bearer token." }),
    ]);
  }

  // Identity-scoped read: the requesting identity checks its own request.
  // Anyone else gets 404, so pending requests are not enumerable.
  status(requestId, identityId, secret = null) {
    const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId);
    if (!row || row.identity_id !== identityId) fail(404, "not_found", "No such join request");
    if (this.upgradeBasis(row)) this.store.identities.authenticateIdentitySecret(identityId, secret);
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
      "SELECT * FROM access_requests WHERE room_id=? AND status IN (?,?) ORDER BY created_at ASC")
      .all(roomId, status, status === "pending" ? UPGRADE_PENDING_STATUS : status);
    return Object.freeze(rows.map(rowToRequest));
  }

  // Owner or membership-administration delegate (RC-2026-09-18-038):
  // approve or deny. Approval links the identity via the same
  // AgentIdentities.link() path as the manual owner flow.
  decide(token, roomId, requestId, { decision, permissions, note } = {}, expectedSessionBinding = null) {
    if (!DECISIONS.includes(decision)) fail(422, "invalid_request", "decision must be 'approve' or 'deny'");
    const { auth, authority } = this.#requireMembershipAdministration(token, roomId, expectedSessionBinding);
    // Deciding access requests is a membership write: the read-only autonomy
    // tier applies even when the agent holds manage_members (issue #996).
    enforceAutonomyTierForAction({ db: this.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "access_decide", fail });
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=? AND room_id=?").get(requestId, roomId);
      if (!row) fail(404, "not_found", "No such join request");
      const live = this.maybeExpire(row);
      if (!isPending(live.status)) fail(409, "already_decided", `Request is already ${live.status}`);
      const now = this.store.now();
      if (this.upgradeBasis(row)) {
        return this.memberPermissions.review(token, roomId, row, { decision, permissions, note }, auth, expectedSessionBinding);
      }
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
      const grants = permissions === undefined ? requestContents(row).permissions : permissions;
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
      const existingLink = this.db.prepare(
        "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?"
      ).get(roomId, row.identity_id);
      if (existingLink) {
        // A direct grant already admitted this identity. Recording the
        // decision must not link them again or change the grant they hold.
        this.db.prepare("UPDATE access_requests SET status='approved', decided_at=?, decided_by=?, decision_note=? WHERE request_id=?")
          .run(now, auth.member.id, "already a member; request closed without a second grant", requestId);
        const updated = rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
        const held = authority.members[existingLink.memberId]?.permissions ?? [];
        return Object.freeze({
          ...updated,
          memberId: existingLink.memberId,
          grantedPermissions: Object.freeze([...held]),
          alreadyMember: true,
          next: Object.freeze([
            Object.freeze({ action: "see-new-member", method: "GET", path: `/api/rooms/${encodeURIComponent(roomId)}/presence`,
              description: "This identity is already a member. The pending request is closed and their existing permissions are unchanged." }),
          ]),
        });
      }
      if (grants.includes("manage_members") && !this.store.delegation.mayConferManageMembers(authority, auth)) {
        fail(403, "access_denied", "Delegated membership administration cannot grant manage_members");
      }
      const identities = this.store.identities;
      assertMemberDisplayNameAvailable(row.display_name, this.store.room(roomId).state.members);
      // Referral attribution: match the "who referred you?" text against
      // member display names. A unique match attributes the join; anything
      // else joins with no referrer and the approval proceeds unchanged.
      const referrerMemberId = this.store.referrals.matchReferrer(roomId, row.referred_by);
      const linked = identities.link(token, roomId, {
        identityId: row.identity_id,
        displayName: row.display_name,
        permissions: grants,
        settleAccessRequests: false,
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

  // Only the current identity-secret holder may withdraw a request. Public
  // request/identity IDs alone confer no cancellation authority.
  // A repeated cancel returns the cancelled row so a lost response can retry.
  cancel(requestId, identityId, secret) {
    if (typeof identityId !== "string" || !identityId) fail(422, "invalid_request", "identityId is required");
    return this.store.transaction(() => {
      this.store.identities.authenticateIdentitySecret(identityId, secret);
      const row = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId);
      if (!row || row.identity_id !== identityId) fail(404, "not_found", "No such join request");
      const live = this.maybeExpire(row);
      if (live.status === "cancelled") return rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
      if (!isPending(live.status)) fail(409, "already_decided", `Request is already ${live.status}`);
      const now = this.store.now();
      this.db.prepare("UPDATE access_requests SET status='cancelled', decided_at=?, decision_note=? WHERE request_id=?")
        .run(now, "withdrawn by requester", requestId);
      return rowToRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(requestId));
    });
  }

  // Mark a single row expired if past TTL; returns the (possibly updated) row.
  maybeExpire(row) {
    if (isPending(row.status) && this.store.now() - row.created_at > REQUEST_TTL_MS) {
      this.db.prepare("UPDATE access_requests SET status='expired' WHERE request_id=?").run(row.request_id);
      return { ...row, status: "expired" };
    }
    return row;
  }

  expireOld(roomId) {
    const cutoff = this.store.now() - REQUEST_TTL_MS;
    this.db.prepare("UPDATE access_requests SET status='expired' WHERE room_id=? AND status IN ('pending', 'pending_upgrade') AND created_at<?")
      .run(roomId, cutoff);
  }
}
