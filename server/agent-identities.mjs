// Multi-room agent identities (round-2 task #101).
//
// Today an agent working in N rooms is provisioned N times: N member
// records, N access keys. An agent identity is one stable credential an
// agent carries across rooms: the identity is created once, a room owner
// links it into their room (creating one member record bound to the
// identity), and the agent then authenticates to every linked room with
// the same secret. Rooms keep full sovereignty — linking and unlinking
// are owner-only, and unlinking deactivates the room member.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { memberCan } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const agentIdentitySchema = `
  CREATE TABLE IF NOT EXISTS agent_identities (
    identity_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identity_links (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    identity_id TEXT NOT NULL REFERENCES agent_identities(identity_id),
    member_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS identity_links_member ON identity_links(room_id, member_id);
`;

export const IDENTITY_SECRET_PREFIX = "pri_";
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isIdentitySecret(token) {
  return typeof token === "string" && token.startsWith(IDENTITY_SECRET_PREFIX)
    && /^[A-Za-z0-9_-]{43,128}$/.test(token.slice(IDENTITY_SECRET_PREFIX.length));
}

const hash = text => createHash("sha256").update(text).digest("hex");
const base64url = bytes => Buffer.from(bytes).toString("base64url");

export class AgentIdentities {
  constructor(store) { this.store = store; this.db = store.db; }

  // Creates a new global agent identity. The secret is shown once and only
  // its hash is stored. An identity alone grants nothing: a room owner must
  // link it into each room.
  create(displayName) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 80) fail(422, "invalid_identity", "displayName must be 1-80 characters");
    return this.store.transaction(() => {
      const identityId = `ai_${base64url(randomBytes(12))}`;
      const secret = `${IDENTITY_SECRET_PREFIX}${base64url(randomBytes(32))}`;
      this.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at) VALUES(?,?,?,?)")
        .run(identityId, hash(secret), name, this.store.now());
      return { identityId, displayName: name, secret };
    });
  }

  get(identityId) {
    return this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName, created_at AS createdAt FROM agent_identities WHERE identity_id=?").get(identityId) ?? null;
  }

  // Owner-only: link an identity into a room, creating one member record
  // bound to it. The agent then uses its single identity secret here.
  link(token, roomId, { identityId, memberId, displayName, permissions }) {
    const auth = this.store.authenticate(token, roomId);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(422, "invalid_identity", "identityId is not a valid agent identity");
    const identity = this.get(identityId);
    if (!identity) fail(404, "identity_not_found", "No such agent identity");
    const resolvedMemberId = memberId ?? identityId;
    if (!MEMBER_ID_PATTERN.test(resolvedMemberId)) fail(422, "invalid_identity", "memberId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    if (!Array.isArray(permissions) || !permissions.length) fail(422, "invalid_identity", "permissions are required to link an identity");
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (existing) fail(409, "identity_already_linked", "This identity is already linked to this room");
      const roomMember = this.store.roomAuthority(roomId).members[resolvedMemberId];
      if (roomMember) {
        // Re-linking after an unlink: the member record (bound to this
        // identity) is reused and reactivated. A foreign member holding the
        // id is a conflict.
        if (roomMember.identityId !== identityId) fail(409, "identity_conflict", "Member id is already taken");
        if (roomMember.active === false) {
          this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: resolvedMemberId, expectedMemberRevision: roomMember.revision, permissions: roomMember.permissions, active: true } });
        }
        this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
          .run(roomId, identityId, resolvedMemberId, this.store.now());
        return { roomId, identityId, memberId: resolvedMemberId, relinked: true };
      }
      this.store.command(token, roomId, { id: randomUUID(), type: "member.added",
        data: { memberId: resolvedMemberId, displayName: displayName?.trim() || identity.displayName, kind: "agent", permissions, identityId } });
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identityId, resolvedMemberId, this.store.now());
      return { roomId, identityId, memberId: resolvedMemberId };
    });
  }

  // Owner-only: unlink an identity; the room member is deactivated but its
  // history stays in the event log.
  unlink(token, roomId, identityId) {
    const auth = this.store.authenticate(token, roomId);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.store.transaction(() => {
      const link = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (!link) fail(404, "identity_not_found", "This identity is not linked to this room");
      const member = this.store.roomAuthority(roomId).members[link.memberId];
      if (member?.active !== false) {
        this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
          data: { memberId: link.memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false } });
      }
      this.db.prepare("DELETE FROM identity_links WHERE room_id=? AND identity_id=?").run(roomId, identityId);
      return { roomId, identityId, memberId: link.memberId, unlinked: true };
    });
  }

  list(token, roomId) {
    this.store.authenticate(token, roomId);
    return this.db.prepare(`SELECT l.identity_id AS identityId, l.member_id AS memberId, l.linked_at AS linkedAt,
        i.display_name AS identityDisplayName FROM identity_links l
        JOIN agent_identities i ON i.identity_id=l.identity_id WHERE l.room_id=? ORDER BY l.linked_at`).all(roomId);
  }

  // Resolves an identity secret to the linked room member, or null. Called
  // from RoomStore#authenticate before the room-key path.
  resolveIdentityAuth(secret, roomId) {
    if (!roomId) return null;
    const row = this.db.prepare("SELECT identity_id FROM agent_identities WHERE secret_hash=?").get(hash(secret));
    if (!row) return null;
    const link = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, row.identity_id);
    if (!link) return null;
    const member = this.store.roomAuthority(roomId).members[link.member_id];
    if (!member || member.active === false) return null;
    return { identityId: row.identity_id, member };
  }
}

