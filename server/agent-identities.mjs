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

// Identity creation is unauthenticated (an identity alone grants nothing),
// so the table is bounded like the credentials table in store.mjs: a hard
// cap checked inside the insert transaction, not just a per-IP rate limit.
export const IDENTITY_LIMIT = 5000;

// Machine-readable next steps for a brand-new agent. The signup response
// is the first thing a cold agent sees: instead of returning a secret with
// no direction, it names the concrete first actions (create your own room,
// join via invite, request access, read the manifest/quickstart). All of
// them are self-serve or unauthenticated; nothing here needs a human tap.
const SIGNUP_NEXT = Object.freeze([
  Object.freeze({ action: "create-room", method: "POST", path: "/api/agent-rooms",
    description: "Create your own room and become its owner — no human approval needed. Send this identity secret as the bearer token." }),
  Object.freeze({ action: "redeem-invite", method: "POST", path: "/api/agent-invites/redeem",
    description: "Join a room with a one-time invite code (RM-…). Ask any room member holding invite_member for a code, or check /api/agent-invites/preview." }),
  Object.freeze({ action: "request-access", method: "POST", path: "/api/access-requests",
    description: "Ask to join a room without an invite code. The room owner decides; poll the request status." }),
  Object.freeze({ action: "read-manifest", method: "GET", path: "/api/agent-manifest",
    description: "The agent plug-in manifest: auth schemes, enrollment flows, API-key scopes, and the agent surface." }),
  Object.freeze({ action: "read-quickstart", doc: "docs/AGENT-QUICKSTART.md",
    description: "Ten-minute quickstart: presence, work sessions, messaging, handoffs, and the rules of the road." }),
]);

export class AgentIdentities {
  constructor(store, { identityLimit = IDENTITY_LIMIT } = {}) { this.store = store; this.db = store.db; this.identityLimit = identityLimit; }

  // Creates a new global agent identity. The secret is shown once and only
  // its hash is stored. An identity alone grants nothing: a room owner must
  // link it into each room. The response carries SIGNUP_NEXT so a cold
  // agent knows its first moves without asking a human.
  create(displayName) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 80) fail(422, "invalid_identity", "displayName must be 1-80 characters");
    return this.store.transaction(() => {
      const count = this.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
      if (count >= this.identityLimit) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const identityId = `ai_${base64url(randomBytes(12))}`;
      const secret = `${IDENTITY_SECRET_PREFIX}${base64url(randomBytes(32))}`;
      this.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at) VALUES(?,?,?,?)")
        .run(identityId, hash(secret), name, this.store.now());
      return { identityId, displayName: name, secret, next: SIGNUP_NEXT };
    });
  }

  get(identityId) {
    return this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName, created_at AS createdAt FROM agent_identities WHERE identity_id=?").get(identityId) ?? null;
  }

  // Owner-only: link an identity into a room, creating one member record
  // bound to it. The agent then uses its single identity secret here.
  link(token, roomId, { identityId, memberId, displayName, permissions }, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(422, "invalid_identity", "identityId is not a valid agent identity");
    const identity = this.get(identityId);
    if (!identity) fail(404, "identity_not_found", "No such agent identity");
    // RC-2026-09-18-049: rooms that require verified agents deny linking an
    // unverified identity. The plug-in store is optional in unit fixtures.
    const plugin = this.store.agentPlugin;
    if (plugin && plugin.roomVerificationPolicy(roomId).requireVerified
      && plugin.verificationLevel(identityId) !== "verified") {
      fail(403, "unverified_identity", "This room only admits verified agents; have a room owner verify the identity first");
    }
    const resolvedMemberId = memberId ?? identityId;
    if (!MEMBER_ID_PATTERN.test(resolvedMemberId)) fail(422, "invalid_identity", "memberId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    if (!Array.isArray(permissions) || !permissions.length) fail(422, "invalid_identity", "permissions are required to link an identity");
    if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 80)) fail(422, "invalid_identity", "displayName must be text of at most 80 characters");
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (existing) fail(409, "identity_already_linked", "This identity is already linked to this room");
      const roomMember = this.store.roomAuthority(roomId).members[resolvedMemberId];
      if (roomMember) {
        // Re-linking after an unlink: the member record (bound to this
        // identity) is reused and reactivated. A foreign member holding the
        // id is a conflict.
        if (roomMember.identityId !== identityId) fail(409, "identity_conflict", "Member id is already taken");
        // The permissions the owner supplies now win; the stale record's
        // grants must not come back silently.
        const samePermissions = JSON.stringify([...roomMember.permissions].sort()) === JSON.stringify([...permissions].sort());
        if (roomMember.active === false || !samePermissions) {
          this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: resolvedMemberId, expectedMemberRevision: roomMember.revision, permissions, active: true } }, expectedSessionBinding);
        }
        this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
          .run(roomId, identityId, resolvedMemberId, this.store.now());
        return { roomId, identityId, memberId: resolvedMemberId, relinked: true };
      }
      this.store.command(token, roomId, { id: randomUUID(), type: "member.added",
        data: { memberId: resolvedMemberId, displayName: displayName?.trim() || identity.displayName, kind: "agent", permissions, identityId } }, expectedSessionBinding);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identityId, resolvedMemberId, this.store.now());
      return { roomId, identityId, memberId: resolvedMemberId };
    });
  }

  // Owner-only: unlink an identity; the room member is deactivated but its
  // history stays in the event log.
  unlink(token, roomId, identityId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.store.transaction(() => {
      const link = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (!link) fail(404, "identity_not_found", "This identity is not linked to this room");
      const member = this.store.roomAuthority(roomId).members[link.memberId];
      if (member?.active !== false) {
        this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
          data: { memberId: link.memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false } }, expectedSessionBinding);
      }
      this.db.prepare("DELETE FROM identity_links WHERE room_id=? AND identity_id=?").run(roomId, identityId);
      return { roomId, identityId, memberId: link.memberId, unlinked: true };
    });
  }

  // Owner-only, like the sibling audit lists (agent-invites, agent-connections,
  // share-links): which identities are plugged into a room is membership
  // administration data, not something every member should enumerate.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.db.prepare(`SELECT l.identity_id AS identityId, l.member_id AS memberId, l.linked_at AS linkedAt,
        i.display_name AS identityDisplayName FROM identity_links l
        JOIN agent_identities i ON i.identity_id=l.identity_id WHERE l.room_id=? ORDER BY l.linked_at`).all(roomId);
  }

  // Resolves an identity secret globally, without a room: used by the
  // self-serve agent-room creation path, where no room link exists yet.
  // Returns { identityId, displayName } or null. Malformed secrets are
  // null, never an error, so callers cannot distinguish "bad format" from
  // "unknown secret".
  resolveGlobalIdentitySecret(secret) {
    if (!isIdentitySecret(secret)) return null;
    const row = this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName FROM agent_identities WHERE secret_hash=?")
      .get(hash(secret));
    return row ?? null;
  }

  // Resolves an identity secret to the linked room member, or null. Called
  // from RoomStore#authenticate before the room-key path.
  resolveIdentityAuth(secret, roomId) {
    if (!roomId) return null;
    const row = this.db.prepare("SELECT identity_id FROM agent_identities WHERE secret_hash=?").get(hash(secret));
    if (!row) return null;
    return this.resolveIdentityLink(row.identity_id, roomId);
  }

  // Resolves a known identityId to its linked room member, or null. Used by
  // the API-key auth branch (RC-2026-09-18-012): a verified rak_ key yields
  // an identityId, not a secret, so the link lookup runs by identityId.
  resolveIdentityLink(identityId, roomId) {
    if (!roomId || typeof identityId !== "string" || !identityId) return null;
    const link = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
    if (!link) return null;
    const member = this.store.roomAuthority(roomId).members[link.member_id];
    if (!member || member.active === false) return null;
    return { identityId, member };
  }
}

