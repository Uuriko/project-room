// Authenticated permission requests by existing room members. No identity is
// minted for a human: the durable principal is explicitly room-member scoped.
import { randomUUID, createHash } from "node:crypto";
import { PERMISSIONS, EVENT_TYPES as T, isRoomArchived, memberCan } from "../src/events.js";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const eventKey = requestId => createHash("sha256").update(`access-request:${requestId}`).digest("hex");

export function permissionRequestContents(row) {
  const stored = JSON.parse(row.requested_permissions);
  if (Array.isArray(stored) && row.status !== "pending_upgrade") return { permissions: stored, upgrade: null };
  if (![1, 2].includes(stored?.version) || stored.kind !== "permission-upgrade"
      || !Array.isArray(stored.permissions) || !stored.permissions.every(p => PERMISSIONS.includes(p))
      || typeof stored.memberId !== "string" || !ID.test(stored.memberId)
      || !Number.isSafeInteger(stored.memberRevision) || stored.memberRevision < 0) {
    fail(409, "invalid_request", "Unsupported stored access request; ask a room owner to review it");
  }
  const roomMember = stored.version === 2 && stored.principal?.kind === "room-member";
  if (stored.version === 2 && (!roomMember || stored.principal.memberId !== stored.memberId
      || row.identity_id !== `member:${stored.memberId}`)) {
    fail(409, "invalid_request", "Unsupported permission-request principal");
  }
  return { permissions: stored.permissions, upgrade: {
    memberId: stored.memberId, revision: stored.memberRevision,
    principalKind: roomMember ? "room-member" : "identity",
    identityId: roomMember ? null : row.identity_id,
    decisionMessageId: stored.decisionMessageId ?? null,
  } };
}

export class MemberPermissionRequests {
  constructor(accessRequests, maxPending = 5) {
    this.access = accessRequests; this.store = accessRequests.store; this.db = accessRequests.db; this.maxPending = maxPending;
  }

  request(token, roomId, { permissions, note, requestId } = {}, binding = null) {
    if (!Array.isArray(permissions) || !permissions.every(p => PERMISSIONS.includes(p)) || new Set(permissions).size !== permissions.length) {
      fail(422, "invalid_request", "permissions must be an array of distinct room permissions");
    }
    if (note != null && (typeof note !== "string" || note.length > 500)) fail(422, "invalid_request", "note must be text of at most 500 characters");
    const rid = requestId ?? `ar_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    if (!ID.test(rid)) fail(422, "invalid_request", "requestId must be a short identifier");
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const member = auth.member;
      const identityId = auth.identityId ?? member.identityId ?? null;
      if (identityId) {
        const linked = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
        if (linked?.member_id !== member.id || this.store.identities.secretRevoked(identityId)) {
          fail(409, "already_member", "Current active linked membership is required");
        }
      }
      const principalId = identityId ?? `member:${member.id}`;
      const existing = this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(rid);
      if (existing) {
        const basis = permissionRequestContents(existing).upgrade;
        if (existing.room_id !== roomId || existing.identity_id !== principalId || basis?.memberId !== member.id) {
          fail(409, "request_conflict", "requestId is already in use");
        }
        return this.access.toRequest(existing);
      }
      const limit = this.access.rateLimiter.check(`access-request:${identityId ?? `${roomId}:${principalId}`}`);
      if (!limit.allowed) fail(429, "rate_limited", limit.message);
      if (permissions.every(p => member.permissions.includes(p))) {
        fail(409, "nothing_to_request", `Already held: ${member.permissions.join(", ") || "read/chat access"}`);
      }
      const room = this.store.room(roomId);
      if (isRoomArchived(room.state)) fail(409, "room_archived", "This room is archived; access cannot be upgraded");
      const pending = this.db.prepare("SELECT count(*) AS n FROM access_requests WHERE room_id=? AND identity_id=? AND status IN ('pending','pending_upgrade')")
        .get(roomId, principalId).n;
      if (pending >= this.maxPending) fail(409, "too_many_requests", `At most ${this.maxPending} pending requests per room`);
      const stored = { version: identityId ? 1 : 2, kind: "permission-upgrade", permissions,
        memberId: member.id, memberRevision: member.revision,
        ...(!identityId ? { principal: { kind: "room-member", memberId: member.id } } : {}) };
      const now = this.store.now();
      this.db.prepare(`INSERT INTO access_requests(request_id,room_id,identity_id,display_name,requested_permissions,note,status,created_at)
        VALUES(?,?,?,?,?,?,'pending_upgrade',?)`).run(rid, roomId, principalId, member.displayName, JSON.stringify(stored), note?.trim() || null, now);
      // The old event vocabulary requires identityId. For a room-only member
      // it is their member ID, explicitly tagged with identityScope below;
      // neither this field nor the storage key creates an agent identity/link.
      this.access.emitAccessRequested(roomId, { requestId: rid, identityId: identityId ?? member.id,
        displayName: member.displayName, requestedPermissions: permissions, note: note?.trim() || null,
        at: now, upgradeMember: member, identityScope: identityId ? "global" : "room-member" });
      return this.access.toRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(rid));
    });
  }

  review(token, roomId, row, { decision, permissions, note }, auth, binding) {
    const contents = permissionRequestContents(row), upgrade = contents.upgrade;
    const authority = this.store.roomAuthority(roomId);
    const member = Object.hasOwn(authority.members, upgrade.memberId) ? authority.members[upgrade.memberId] : null;
    const recorded = this.db.prepare("SELECT body FROM events WHERE room_id=? AND id=?").get(roomId, eventKey(row.request_id));
    const basisEvent = recorded ? JSON.parse(recorded.body) : null;
    const eventIdentityId = upgrade.identityId ?? upgrade.memberId;
    const linked = upgrade.identityId ? this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?")
      .get(roomId, upgrade.identityId) : null;
    if (decision === "approve") {
      if (!member || member.active === false || member.revision !== upgrade.revision
          || (upgrade.identityId && (linked?.member_id !== member.id || member.identityId !== upgrade.identityId || this.store.identities.secretRevoked(upgrade.identityId)))
          || basisEvent?.type !== T.ACCESS_REQUESTED || basisEvent.data.requestId !== row.request_id
          || basisEvent.data.identityId !== eventIdentityId || basisEvent.actorId !== eventIdentityId
          || basisEvent.data.upgradeMemberId !== upgrade.memberId || basisEvent.data.expectedMemberRevision !== upgrade.revision) {
        fail(409, "stale_membership", "Membership changed since this request; review current access and submit a new request");
      }
      if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "manage_members required to approve additional permissions");
      const grants = permissions === undefined ? contents.permissions : permissions;
      if (!Array.isArray(grants) || !grants.every(p => PERMISSIONS.includes(p))) fail(422, "invalid_request", "permissions must be room permissions");
      const missing = auth.member.id === authority.ownerId ? [] : grants.filter(p => !auth.member.permissions.includes(p));
      if (missing.length) fail(403, "access_denied", `Cannot grant permissions not held: ${missing.join(", ")}`);
      const effective = [...new Set([...member.permissions, ...grants])];
      if (effective.length !== member.permissions.length) {
        this.store.command(token, roomId, { id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
          data: { memberId: member.id, expectedMemberRevision: member.revision, permissions: effective, active: true } }, binding);
      }
    }
    if (note != null && (typeof note !== "string" || note.length > 500)) fail(422, "invalid_request", "note must be text of at most 500 characters");
    const granted = decision === "approve" ? (permissions === undefined ? contents.permissions : permissions) : [];
    const messageId = randomUUID();
    const body = decision === "approve"
      ? `Approved permission request ${row.request_id} for ${row.display_name}. Approved permissions: ${granted.join(", ") || "none added"}. Existing access is preserved.`
      : `Declined permission request ${row.request_id} for ${row.display_name}. Existing access is unchanged.${note?.trim() ? ` ${note.trim()}` : ""}`;
    // Existing message commands retain ordinary actor authority, archival and
    // capacity checks. The surrounding decision transaction makes this atomic.
    this.store.command(token, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED,
      ...(basisEvent ? { causationId: basisEvent.id } : {}), data: { messageId, body } }, binding);
    const stored = JSON.parse(row.requested_permissions);
    stored.decisionMessageId = messageId;
    this.db.prepare("UPDATE access_requests SET status=?,decided_at=?,decided_by=?,decision_note=?,requested_permissions=? WHERE request_id=?")
      .run(decision === "approve" ? "approved" : "denied", this.store.now(), auth.member.id, note?.trim() || null, JSON.stringify(stored), row.request_id);
    const updated = this.access.toRequest(this.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(row.request_id));
    return Object.freeze({ ...updated, memberId: upgrade.memberId, decisionMessageId: messageId,
      ...(decision === "approve" ? { grantedPermissions: Object.freeze([...this.store.roomAuthority(roomId).members[upgrade.memberId].permissions]) } : {}) });
  }
}

// Resolve only the bounded feed's causally linked messages. An arbitrary chat
// message cannot claim to be a decision: its ID must match the durable row.
export function permissionDecisionMessages(store, rows) {
  const decisions = new Map();
  for (const { event } of rows) {
    if (event.type !== T.MESSAGE_POSTED || !event.causationId) continue;
    const basis = store.db.prepare("SELECT body FROM events WHERE room_id=? AND id=?").get(event.roomId, event.causationId);
    const requestEvent = basis ? JSON.parse(basis.body) : null;
    if (requestEvent?.type !== T.ACCESS_REQUESTED) continue;
    const row = store.db.prepare("SELECT * FROM access_requests WHERE room_id=? AND request_id=?").get(event.roomId, requestEvent.data.requestId);
    if (!row || !["approved", "denied"].includes(row.status)) continue;
    const upgrade = permissionRequestContents(row).upgrade;
    if (upgrade?.decisionMessageId !== event.data.messageId) continue;
    decisions.set(event.data.messageId, { requestId: row.request_id, memberId: upgrade.memberId,
      outcome: row.status, eventId: event.id });
  }
  return decisions;
}
