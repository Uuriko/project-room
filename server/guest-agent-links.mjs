import { createHash } from "node:crypto";
import { EVENT_TYPES as T, validId } from "../src/events.js";

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
export const GUEST_AGENT_TTL_MS = 2 * 60 * 60 * 1000;
export const GUEST_AGENT_MAX_JOINS = 10;
export const GUEST_AGENT_MEMBER_PREFIX = "guest-agent-";
export const GUEST_AGENT_STATUS = "live";
export const GUEST_AGENT_DEFAULT_NAME = "Guest agent";
const ACCESS = "Read the room and its history, post messages, and react. No membership administration or work approvals.";

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

export function guestAgentLinkContract() {
  return {
    status: GUEST_AGENT_STATUS,
    kind: GUEST_AGENT_KIND,
    permissions: [...GUEST_AGENT_PERMISSIONS],
    access: "read_chat",
    ttlMs: GUEST_AGENT_TTL_MS,
    maxJoins: GUEST_AGENT_MAX_JOINS,
    hashPath: GUEST_AGENT_HASH_PATH,
    tokenPrefix: GUEST_AGENT_TOKEN_PREFIX,
    account: false,
    separateFromHumanShareLinks: true,
    mint: "owner_issued",
    anyoneWithLink: false,
    schemaBump: false
  };
}

function assertGuestAgentToken(token) {
  const kind = classifyJoinToken(token);
  if (kind === "human-share") fail(422, "wrong_link_kind", "Human invitation links are not agent credentials.");
  if (kind !== "guest-agent") fail(410, "link_unavailable", "This guest-agent link is not valid.");
}

function displayNameOf(value) {
  const name = value === undefined ? GUEST_AGENT_DEFAULT_NAME : value;
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(422, "invalid_link", "Choose a short guest-agent name");
  }
  return name.trim();
}

// Owner-issued vertical: no new table / writer bump. The link token is the
// ephemeral access credential. Anyone-with-link redeem storage stays deferred.
export class GuestAgentLinks {
  constructor(store) { this.store = store; this.db = store.db; }

  owner(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    if (!auth.account || auth.member.kind !== "human"
      || auth.member.id !== this.store.room(roomId).state.room.ownerId
      || !auth.member.permissions.includes("manage_members")) {
      fail(403, "owner_required", "Only the room owner can mint a guest-agent credential. Use Add agent for a durable key.");
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

  roomAccess() {
    return ACCESS;
  }

  previewPublic(row, member) {
    const room = this.store.room(row.room_id).state.room;
    return {
      room: { id: room.id, title: room.title },
      access: ACCESS,
      kind: GUEST_AGENT_KIND,
      permissions: [...GUEST_AGENT_PERMISSIONS],
      expiresAt: row.expires_at,
      hashPath: GUEST_AGENT_HASH_PATH,
      account: false
    };
  }

  conflict(tokenHash) {
    for (const [table, column] of [["credentials", "hash"], ["account_credentials", "hash"], ["account_session_slots", "hash"],
      ["membership_invitations", "token_hash"], ["share_links", "token_hash"]]) {
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(tokenHash)) fail(409, "token_conflict", "Generate a new guest-agent token");
    }
  }

  liveCount(roomId) {
    const members = this.store.room(roomId).state.members;
    let n = 0;
    for (const member of Object.values(members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== GUEST_AGENT_KIND || member.active === false) continue;
      const row = this.db.prepare("SELECT revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access'").get(roomId, member.id);
      if (row && row.revoked === 0 && row.expires_at > this.store.now()) n++;
    }
    return n;
  }

  sweepExpired(token, roomId, binding) {
    const members = this.store.room(roomId).state.members;
    for (const member of Object.values(members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== GUEST_AGENT_KIND || member.active === false) continue;
      const row = this.db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access'").get(roomId, member.id);
      if (row && row.revoked === 0 && row.expires_at > this.store.now()) continue;
      this.store.command(token, roomId, {
        id: `guest-agent-end-${hash(`${member.id}:${row?.hash || "none"}`).slice(0, 40)}`,
        type: T.MEMBER_ACCESS_CHANGED,
        data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions }
      }, binding);
    }
  }

  mint(token, roomId, details, binding) {
    if (!details || Array.isArray(details) || typeof details !== "object") fail(422, "invalid_link", "Supply the guest-agent mint fields");
    const allowed = ["requestId", "linkToken", "expectedOwnerRevision", "displayName", "roomId"];
    if (Object.keys(details).some(key => !allowed.includes(key))) fail(422, "invalid_link", "Supply the guest-agent mint fields");
    const { requestId, linkToken, expectedOwnerRevision } = details;
    if (!validId(requestId) || classifyJoinToken(linkToken) !== "guest-agent"
      || !Number.isSafeInteger(expectedOwnerRevision) || expectedOwnerRevision < 0) {
      fail(422, "invalid_link", "Supply a ga1. token, requestId and current owner revision");
    }
    if (details.roomId !== undefined && details.roomId !== roomId) fail(422, "invalid_link", "Room does not match this mint");
    const displayName = displayNameOf(details.displayName);
    return this.store.transaction(() => {
      const auth = this.owner(token, roomId, binding);
      if (expectedOwnerRevision !== auth.member.revision) fail(409, "stale_member_revision", "Your room permissions changed; refresh before minting");
      this.sweepExpired(token, roomId, binding);
      const memberId = guestAgentMemberId(auth.account.id, requestId);
      const existing = this.store.room(roomId).state.members[memberId];
      const prior = this.credential(linkToken);
      if (existing) {
        if (existing.kind !== GUEST_AGENT_KIND || existing.active === false) {
          fail(409, "membership_ended", "This guest-agent membership ended; use a new requestId");
        }
        if (!prior || prior.room_id !== roomId || prior.member_id !== memberId || !this.liveCredential(prior, existing)
          || existing.displayName !== displayName) {
          fail(409, "idempotency_conflict", "This requestId was already used for a different guest-agent mint");
        }
        return { ...this.issued(linkToken, prior, existing, roomId), duplicate: true };
      }
      if (this.liveCount(roomId) >= GUEST_AGENT_MAX_JOINS) fail(429, "rate_limited", "Guest-agent mint limit reached for this room; wait for expiry or disconnect one");
      if (this.db.prepare("SELECT count(*) n FROM credentials WHERE room_id=?").get(roomId).n >= 5000) fail(409, "pilot_limit", "Credential retention limit reached");
      this.conflict(hash(linkToken));
      const membership = this.store.command(token, roomId, {
        id: `guest-agent-${hash(`${auth.account.id}:${requestId}`).slice(0, 40)}`,
        type: T.MEMBER_ADDED,
        data: { memberId, displayName, kind: GUEST_AGENT_KIND, permissions: [...GUEST_AGENT_PERMISSIONS], accountableHumanId: auth.member.id }
      }, binding);
      const expiresAt = this.store.now() + GUEST_AGENT_TTL_MS;
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(linkToken), roomId, memberId, expiresAt);
      const member = this.store.room(roomId).state.members[memberId];
      const row = this.credential(linkToken);
      return { ...this.issued(linkToken, row, member, roomId), membershipEventId: membership.event.id, duplicate: false };
    });
  }

  issued(linkToken, row, member, roomId) {
    return {
      token: linkToken,
      member: { id: member.id, kind: member.kind, permissions: [...member.permissions], expiresAt: row.expires_at },
      room: { id: roomId },
      access: "read_chat",
      expiresAt: row.expires_at,
      hashPath: GUEST_AGENT_HASH_PATH,
      account: false
    };
  }

  preview(linkToken) {
    assertGuestAgentToken(linkToken);
    return this.store.readTransaction(() => {
      const row = this.credential(linkToken);
      const member = row && this.store.room(row.room_id).state.members[row.member_id];
      if (!this.liveCredential(row, member)) fail(410, "link_unavailable", "This guest-agent link is not valid.");
      return this.previewPublic(row, member);
    });
  }

  join(linkToken) {
    assertGuestAgentToken(linkToken);
    return this.store.transaction(() => {
      const row = this.credential(linkToken);
      const member = row && this.store.room(row.room_id).state.members[row.member_id];
      if (!this.liveCredential(row, member)) fail(410, "link_unavailable", "This guest-agent link is not valid.");
      const preview = this.previewPublic(row, member);
      return { ...preview, memberId: member.id, access: "read_chat" };
    });
  }
}
