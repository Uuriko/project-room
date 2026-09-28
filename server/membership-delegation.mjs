// Owner-only membership delegation. Active authority lives in the grant table;
// an append-only journal records decisions, with legacy baseline rows for
// pre-journal grants. The member-bit path is separate and revokeEffective
// clears both paths. Agent delegates cannot confer manage_members.

import { randomUUID } from "node:crypto";

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Mirrors memberCan() from src/events.js (Workers-bundle reason as above).
const memberCan = (authority, memberId, permission) => {
  const member = authority?.members?.[memberId];
  return Array.isArray(member?.permissions) && member.permissions.includes(permission);
};

export const membershipDelegationSchema = `
  CREATE TABLE IF NOT EXISTS membership_delegation_grants (
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    added_invite_member INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS membership_delegation_grants_room ON membership_delegation_grants(room_id, revoked_at);
`;

const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class MembershipDelegation {
  constructor(store) { this.store = store; this.db = store.db; }

  // Owner-only: grant membership administration to a linked agent identity.
  grant(token, roomId, { identityId } = {}, expectedSessionBinding = null) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) {
      fail(422, "invalid_identity", "identityId is not a valid agent identity");
    }
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    const target = this.store.identities.resolveIdentityLink(identityId, roomId);
    if (!target) fail(404, "not_found", "No such linked agent identity in this room");
    if (target.member.kind !== "agent") fail(422, "invalid_identity", "Membership administration can only be delegated to an agent identity");
    if (target.member.id === authority.ownerId) {
      fail(409, "already_administers", "That identity is the room owner and already administers membership");
    }
    return this.store.transaction(() => {
      this.store.delegationJournal.verify();
      const existing = this.db.prepare(
        "SELECT revoked_at FROM membership_delegation_grants WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (existing && existing.revoked_at == null) fail(409, "grant_active", "Membership administration is already granted to this identity");
      const now = this.store.now();
      if (existing) {
        this.db.prepare(
          "UPDATE membership_delegation_grants SET granted_by=?, granted_at=?, revoked_at=NULL WHERE room_id=? AND identity_id=?")
          .run(auth.member.id, now, roomId, identityId);
      } else {
        this.db.prepare(
          "INSERT INTO membership_delegation_grants(room_id, identity_id, granted_by, granted_at, revoked_at, added_invite_member) VALUES(?,?,?,?,NULL,0)")
          .run(roomId, identityId, auth.member.id, now);
      }
      // Approving a request drives AgentIdentities.link() with the
      // approver's token, and link()'s member.added event takes the
      // agent-safe branch only when the actor holds invite_member (or
      // manage_members). invite_member is the agent-safe permission the
      // model already lets agents hold ("agents may hold invite_member
      // without manage_members/decide"), so the grant adds it on the way
      // in; revoke() strips it on the way out. The owner issuing the
      // member.access_changed event is the audit trail, and manage_members
      // itself never enters the agent's member record.
      const member = this.store.roomAuthority(roomId).members[target.member.id];
      const addedInvite = member && !member.permissions.includes("invite_member")
        ? (this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: member.id, expectedMemberRevision: member.revision,
              permissions: [...member.permissions, "invite_member"], active: member.active } },
            expectedSessionBinding),
          true)
        : false;
      this.db.prepare(
        "UPDATE membership_delegation_grants SET added_invite_member=? WHERE room_id=? AND identity_id=?")
        .run(addedInvite ? 1 : 0, roomId, identityId);
      this.store.delegationJournal.append(roomId, identityId, "grant", auth.member.id, now, false, true);
      return Object.freeze({ roomId, identityId, grantedBy: auth.member.id, grantedAt: now });
    });
  }

  // Owner-only: revoke a grant. The grant holder can never revoke its own
  // grant (it is not the owner) — revocation is strictly top-down.
  revoke(token, roomId, { identityId } = {}, expectedSessionBinding = null) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) {
      fail(422, "invalid_identity", "identityId is not a valid agent identity");
    }
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    return this.store.transaction(() => {
      this.store.delegationJournal.verify();
      const existing = this.db.prepare(
        "SELECT added_invite_member FROM membership_delegation_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL").get(roomId, identityId);
      if (!existing) fail(404, "not_found", "No active membership-administration grant for this identity");
      const now = this.store.now();
      this.db.prepare(
        "UPDATE membership_delegation_grants SET revoked_at=? WHERE room_id=? AND identity_id=?")
        .run(now, roomId, identityId);
      // Strip the invite_member the grant added on the way in, restoring
      // the member's prior permission set. (If the member was unlinked or
      // already carried invite_member, there is nothing to restore.)
      if (existing.added_invite_member) {
        const link = this.store.identities.resolveIdentityLink(identityId, roomId);
        const member = link?.member;
        if (member && member.active !== false && member.permissions.includes("invite_member")) {
          this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: member.id, expectedMemberRevision: member.revision,
              permissions: member.permissions.filter(p => p !== "invite_member"), active: member.active } },
            expectedSessionBinding);
        }
      }
      this.store.delegationJournal.append(roomId, identityId, "revoke", auth.member.id, now, true, false);
      return Object.freeze({ roomId, identityId, revoked: true });
    });
  }

  // Owner-only: list active grants.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    const rows = this.db.prepare(
      "SELECT room_id, identity_id, granted_by, granted_at FROM membership_delegation_grants WHERE room_id=? AND revoked_at IS NULL ORDER BY granted_at ASC")
      .all(roomId);
    return Object.freeze(rows.map(row => Object.freeze({
      roomId: row.room_id, identityId: row.identity_id, grantedBy: row.granted_by, grantedAt: row.granted_at
    })));
  }

  // Does the identity hold an active grant in this room right now?
  hasGrant(roomId, identityId) {
    if (typeof roomId !== "string" || !roomId || typeof identityId !== "string" || !identityId) return false;
    const row = this.db.prepare(
      "SELECT 1 FROM membership_delegation_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL").get(roomId, identityId);
    return !!row;
  }

  // The one predicate every membership-administration gate uses: the
  // caller's own manage_members permission, or an active owner grant on
  // the caller's agent identity. The caller's identity is the
  // identity-scoped token's identityId when present (API keys, identity
  // secrets), else the identityId bound to their linked member record.
  canAdministerMembership(authority, auth, roomId) {
    if (memberCan(authority, auth?.member?.id, "manage_members")) return true;
    const callerIdentityId = auth?.identityId ?? auth?.member?.identityId ?? null;
    return this.hasGrant(roomId, callerIdentityId);
  }

  // Whether the caller may confer manage_members on someone else: the room
  // owner, or a member who already holds manage_members. A delegate acting
  // purely on an owner grant may admit members but may never mint new
  // membership administrators — otherwise the grant would be transitive
  // (delegate approves/link with manage_members, the new member administers
  // membership, the delegation boundary collapses).
  mayConferManageMembers(authority, auth) {
    if (auth?.member?.id === authority?.ownerId) return true;
    return memberCan(authority, auth?.member?.id, "manage_members");
  }

  // One owner action for both administration stores. A #761 table grant and a
  // #742 delegatedAdmin member bit can be active together. Revoking only the
  // table row leaves the member bit, and stripping only the bit leaves the
  // table row. This clears whichever of those is present so the next access
  // review shows no membership-administration path for the identity.
  revokeEffective(token, roomId, { identityId } = {}, expectedSessionBinding = null) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) {
      fail(422, "invalid_identity", "identityId is not a valid agent identity");
    }
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    const adminBits = ["manage_members", "decide"];
    return this.store.transaction(() => {
      this.store.delegationJournal.verify();
      const grant = this.db.prepare(
        "SELECT added_invite_member FROM membership_delegation_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL").get(roomId, identityId);
      const target = this.store.identities.resolveIdentityLink(identityId, roomId);
      const member = target ? this.store.roomAuthority(roomId).members[target.member.id] : null;
      if (member?.id === authority.ownerId) fail(409, "already_administers", "The room owner retains membership administration");
      const hasAdmin = !!member && member.permissions.some(permission => adminBits.includes(permission));
      if (!grant && !hasAdmin) fail(404, "not_found", "No membership-administration authority for this identity");
      const now = this.store.now();
      if (grant) {
        this.db.prepare("UPDATE membership_delegation_grants SET revoked_at=? WHERE room_id=? AND identity_id=?")
          .run(now, roomId, identityId);
      }
      let strippedAdmin = false;
      if (member && member.active !== false) {
        let permissions = [...member.permissions];
        if (grant?.added_invite_member) permissions = permissions.filter(permission => permission !== "invite_member");
        if (permissions.some(permission => adminBits.includes(permission))) strippedAdmin = true;
        permissions = permissions.filter(permission => !adminBits.includes(permission));
        if (permissions.length !== member.permissions.length || permissions.some((permission, index) => permission !== member.permissions[index])) {
          this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: member.id, expectedMemberRevision: member.revision, permissions, active: member.active } },
            expectedSessionBinding);
        }
      }
      if (grant) this.store.delegationJournal.append(roomId, identityId, "revoke_effective", auth.member.id, now, true, false);
      return Object.freeze({ roomId, identityId, revokedGrant: !!grant, strippedAdmin });
    });
  }

  #requireOwner(auth, authority) {
    if (auth?.member?.id !== authority?.ownerId) {
      fail(403, "access_denied", "Only the room owner may grant or revoke membership administration");
    }
  }
}
