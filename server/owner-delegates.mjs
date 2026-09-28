// Owner delegates: agents the room owner explicitly grants to act with the
// owner's authority in a room.
//
// Seeded by the room owner's direct order (John Potter, 2026-09-28, verbatim:
// "Change the code to give yourself ultimate authority as me in project room
// so you can do anything").
//
// This is delegation, not impersonation, and the design is deliberately not
// a backdoor:
//
// - No code trust root: a delegate holds a persisted, per-room grant row.
//   Nothing in this file names an identity. Only the room owner can grant
//   or revoke, through the owner-only routes in server/http.mjs.
// - Identity-bound: the delegate authenticates on their own identity secret.
// - Active-membership-bound: the grant resolves only while the identity is
//   linked to an active member record in the room (resolveIdentityLink).
// - No self-escalation: grant/revoke/list require the caller's member id to
//   equal the room owner id, so a delegate's id never passes.
// - Immediate revocation: revoked_at is checked on every authenticate; no
//   cache sits between the revoke and the next request.
// - Audited: grant/revoke decisions append to owner_delegate_journal with
//   the acting owner; delegated actions journal the delegate as the actor
//   (e.g. guest_invites.minted_by_member_id), and mechanical sweeps record
//   the delegation provenance in the event data.
// - Carve-outs stay owner-only: ownership transfer, human-session
//   impersonation, and spend allowance never name the delegate flag, so a
//   delegate can never reach them.

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const ownerDelegateSchema = `
  CREATE TABLE IF NOT EXISTS owner_delegate_grants (
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS owner_delegate_grants_room ON owner_delegate_grants(room_id, revoked_at);
  CREATE TABLE IF NOT EXISTS owner_delegate_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
    actor_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS owner_delegate_journal_room ON owner_delegate_journal(room_id, sequence);
`;

const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class OwnerDelegates {
  constructor(store) { this.store = store; this.db = store.db; }

  // Owner-only: grant owner delegation to a linked agent identity in this
  // room. The holder's identity secret then authenticates with the owner's
  // authority on the routes that name the delegate flag explicitly.
  grant(token, roomId, { identityId } = {}, expectedSessionBinding = null) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) {
      fail(422, "invalid_identity", "identityId is not a valid agent identity");
    }
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    const target = this.store.identities.resolveIdentityLink(identityId, roomId);
    if (!target) fail(404, "not_found", "No such linked agent identity in this room");
    if (target.member.kind !== "agent") fail(422, "invalid_identity", "Owner delegation can only be granted to an agent identity");
    if (target.member.id === authority.ownerId) {
      fail(409, "already_owner", "That identity is the room owner and already holds full authority");
    }
    return this.store.transaction(() => {
      const existing = this.db.prepare(
        "SELECT revoked_at FROM owner_delegate_grants WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (existing && existing.revoked_at == null) fail(409, "grant_active", "Owner delegation is already granted to this identity");
      const now = this.store.now();
      if (existing) {
        this.db.prepare(
          "UPDATE owner_delegate_grants SET granted_by=?, granted_at=?, revoked_at=NULL WHERE room_id=? AND identity_id=?")
          .run(auth.member.id, now, roomId, identityId);
      } else {
        this.db.prepare(
          "INSERT INTO owner_delegate_grants(room_id, identity_id, granted_by, granted_at, revoked_at) VALUES(?,?,?,?,NULL)")
          .run(roomId, identityId, auth.member.id, now);
      }
      this.#journal(roomId, identityId, "grant", auth.member.id, now);
      return Object.freeze({ roomId, identityId, grantedBy: auth.member.id, grantedAt: now });
    });
  }

  // Owner-only: revoke a grant. Revocation is strictly top-down — the grant
  // holder can never revoke its own grant (it is not the owner) — and takes
  // effect on the next authenticated request.
  revoke(token, roomId, { identityId } = {}, expectedSessionBinding = null) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) {
      fail(422, "invalid_identity", "identityId is not a valid agent identity");
    }
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    return this.store.transaction(() => {
      const existing = this.db.prepare(
        "SELECT 1 FROM owner_delegate_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL").get(roomId, identityId);
      if (!existing) fail(404, "not_found", "No active owner-delegation grant for this identity");
      const now = this.store.now();
      this.db.prepare(
        "UPDATE owner_delegate_grants SET revoked_at=? WHERE room_id=? AND identity_id=?")
        .run(now, roomId, identityId);
      this.#journal(roomId, identityId, "revoke", auth.member.id, now);
      return Object.freeze({ roomId, identityId, revokedBy: auth.member.id, revokedAt: now });
    });
  }

  // Owner-only: list the active grants in this room.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    const rows = this.db.prepare(
      "SELECT room_id, identity_id, granted_by, granted_at FROM owner_delegate_grants WHERE room_id=? AND revoked_at IS NULL ORDER BY granted_at ASC")
      .all(roomId);
    return Object.freeze(rows.map(row => Object.freeze({
      roomId: row.room_id, identityId: row.identity_id, grantedBy: row.granted_by, grantedAt: row.granted_at
    })));
  }

  // Owner-only: read the grant/revoke journal for this room (audit).
  journal(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    this.#requireOwner(auth, authority);
    const rows = this.db.prepare(
      "SELECT sequence, identity_id, action, actor_id, recorded_at FROM owner_delegate_journal WHERE room_id=? ORDER BY sequence DESC LIMIT 100")
      .all(roomId);
    return Object.freeze(rows.map(row => Object.freeze({
      sequence: row.sequence, identityId: row.identity_id, action: row.action,
      actorId: row.actor_id, recordedAt: row.recorded_at
    })));
  }

  // Does the identity hold an active grant in this room right now? The one
  // predicate RoomStore#authenticate uses to stamp the delegate flag.
  hasGrant(roomId, identityId) {
    if (typeof roomId !== "string" || !roomId || typeof identityId !== "string" || !identityId) return false;
    const row = this.db.prepare(
      "SELECT 1 FROM owner_delegate_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL").get(roomId, identityId);
    return !!row;
  }

  #journal(roomId, identityId, action, actorId, at) {
    this.db.prepare(
      "INSERT INTO owner_delegate_journal(room_id, identity_id, action, actor_id, recorded_at) VALUES(?,?,?,?,?)")
      .run(roomId, identityId, action, actorId, at);
  }

  #requireOwner(auth, authority) {
    // A delegate's member id is never the owner id, so the delegate flag
    // can never satisfy this check: grants are strictly top-down.
    if (auth?.member?.id !== authority?.ownerId) {
      fail(403, "access_denied", "Only the room owner may grant, revoke, or list owner delegation");
    }
  }
}
