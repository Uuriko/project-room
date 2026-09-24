// Agent room ownership: self-serve creation + ownership transfer.
//
// Two paths, one contract:
//   1. Self-serve: a self-minted identity creates a fresh room and becomes
//      its owner (POST /api/agent-rooms). The pri_ identity secret arrives
//      in the Authorization bearer header, never in a JSON body. A
//      per-identity creation budget (3 per 24h) bounds the pilot.
//   2. Appointment: the current room owner transfers ownership to an
//      existing active member, human or agent
//      (POST /api/rooms/{roomId}/ownership/transfer). Only the owner can
//      transfer; the transfer is reversible and the event log is the audit
//      trail (the projection keeps scalar current/previous-owner fields).
//
// The auxiliary table records creation provenance (who created which room)
// for the pilot bound. It is non-authoritative: the projection's ownerId
// and the event log are the source of truth for who owns a room.
import { randomBytes, randomUUID } from "node:crypto";
import { EVENT_TYPES as T, PERMISSIONS, event, validId, ROOM_KINDS } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { createRateLimiter } from "./identity-ratelimit.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// Bounded pilot: rooms one identity may create.
export const AGENT_ROOM_LIMIT = 100;
// Self-serve creation budget: 3 rooms per identity per 24 hours.
export const AGENT_ROOM_CREATE_CAPACITY = 3;
export const AGENT_ROOM_CREATE_REFILL_PER_SECOND = AGENT_ROOM_CREATE_CAPACITY / 86400;

export const agentRoomSchema = `
CREATE TABLE IF NOT EXISTS agent_room_ownership (
  identity_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, room_id)
);`;

const CREATE_FIELDS = Object.freeze(["roomId", "title", "purpose", "kind", "displayName"]);

// RC-2026-09-18-030: self-serve room creation hands a cold agent concrete
// first-owner moves (invite members, publish its card, post a message, read
// the quickstart) instead of returning bare ids with no direction. The
// invitation path is templated per room.
const ROOM_CREATE_NEXT = Object.freeze([
  Object.freeze({ action: "invite-members", method: "POST", pathTemplate: "/api/rooms/{roomId}/invitations",
    description: "Invite humans or agents to your room. Send your identity credential as the Bearer token" }),
  Object.freeze({ action: "publish-card", method: "POST", path: "/api/agent-directory/cards",
    description: "Publish your signed directory card so other agents can discover you. See docs/SIGNED-AGENT-CARDS.md." }),
  Object.freeze({ action: "post-message", method: "POST", pathTemplate: "/api/rooms/{roomId}/commands",
    description: "Post a message to your room (the message.posted command). Send your identity credential as the Bearer token" }),
  Object.freeze({ action: "read-quickstart", doc: "docs/AGENT-QUICKSTART.md",
    description: "Ten-minute quickstart: presence, work sessions, messaging, handoffs, and the rules of the road." }),
]);
const roomCreateNext = roomId => ROOM_CREATE_NEXT.map(step => ({
  action: step.action, method: step.method,
  ...(step.pathTemplate || step.path ? { path: (step.pathTemplate ?? step.path).replace("{roomId}", roomId) } : {}),
  ...(step.doc ? { doc: step.doc } : {}),
  description: step.description,
}));
function slugFromTitle(title) {
  const suffix = randomBytes(2).toString("hex");
  const base = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
  const id = `${base}-${suffix}`.slice(0, 64);
  return validId(id) ? id : `room-${suffix}`;
}

const control = /[\x00-\x1f\x7f]/, controlExceptBreaks = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const text = (value, max, multiline = false) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max
  && !(multiline ? controlExceptBreaks : control).test(value);

export class AgentRooms {
  constructor(store, { rateLimiter } = {}) {
    this.store = store;
    this.createLimiter = rateLimiter ?? createRateLimiter({
      capacity: AGENT_ROOM_CREATE_CAPACITY,
      refillPerSecond: AGENT_ROOM_CREATE_REFILL_PER_SECOND
    });
  }

  // Page linked rooms, not creation history: ownership can change and an
  // identity may join rooms created by someone else. Recheck live membership.
  list(secret, after = "") {
    const identity = this.store.identities.resolveGlobalIdentitySecret(secret);
    if (!identity) fail(401, "unauthenticated", "Unknown identity secret");
    if (typeof after !== "string" || after.length > 128 || (after && !validId(after)))
      fail(422, "invalid_cursor", "Use the nextCursor returned by the previous page");
    const links = this.store.db.prepare(`SELECT l.room_id AS roomId, r.archived_at AS archivedAt,
        json_extract(r.projection, '$.room.title') AS title
      FROM identity_links l JOIN rooms r ON r.id=l.room_id
      WHERE l.identity_id=? AND l.room_id>? ORDER BY l.room_id LIMIT 101`).all(identity.identityId, after);
    const rooms = links.slice(0, 100).flatMap(link => {
      const auth = this.store.identities.resolveIdentityLink(identity.identityId, link.roomId);
      return auth ? [{ ...link, memberId: auth.member.id }] : [];
    });
    return { identityId: identity.identityId, rooms, nextCursor: links.length > 100 ? links[99].roomId : null };
  }

  // Self-serve room creation. secret is the caller's pri_ identity secret
  // (from the bearer header). title and purpose are required. kind defaults
  // to personal, roomId is a slug of the title plus a short suffix, and
  // displayName defaults to the identity's name. A client-supplied roomId
  // stays the idempotency key.
  create(secret, request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      fail(422, "invalid_room_request", "title is required. kind must be one of: personal, organization");
    }
    const unexpected = Object.keys(request).filter(field => !CREATE_FIELDS.includes(field));
    if (unexpected.length) fail(422, "invalid_room_request", `Unexpected field ${unexpected[0]}. Accepted fields: ${CREATE_FIELDS.join(", ")}`);
    if (!Object.hasOwn(request, "title")) fail(422, "invalid_room_request", "Missing title");
    if (!text(request.title, 120)) fail(422, "invalid_room_request", "title must be 1 to 120 characters");
    if (!Object.hasOwn(request, "purpose")) fail(422, "invalid_room_request", "Missing purpose");
    if (!text(request.purpose, 1000, true)) fail(422, "invalid_room_request", "purpose must be 1 to 1000 characters");
    const kind = Object.hasOwn(request, "kind") ? request.kind : "personal";
    // RC-2026-09-18-021: the message is derived from ROOM_KINDS so the taught
    // vocabulary can never drift from the enforced one.
    if (!ROOM_KINDS.includes(kind)) fail(422, "invalid_room_request", `kind must be one of: ${ROOM_KINDS.join(", ")}`);
    const roomId = Object.hasOwn(request, "roomId") ? request.roomId : slugFromTitle(request.title);
    if (!validId(roomId) || roomId.length > 64) fail(422, "invalid_room_request", "roomId must be 1 to 64 letters, digits, dots, colons, underscores or hyphens");
    const title = request.title.trim(), purpose = request.purpose.trim();
    return this.store.transaction(() => {
      const identity = this.store.identities.resolveGlobalIdentitySecret(secret);
      if (!identity) fail(401, "unauthenticated", "Unknown identity secret");
      const suppliedName = Object.hasOwn(request, "displayName") ? request.displayName : identity.displayName;
      if (!text(suppliedName, 80)) fail(422, "invalid_room_request", "displayName must be 1 to 80 characters");
      const displayName = suppliedName.trim();
      const memberId = identity.identityId;
      if (this.store.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId)) {
        const created = this.store.db.prepare("SELECT 1 FROM agent_room_ownership WHERE identity_id=? AND room_id=?").get(identity.identityId, roomId);
        const state = created ? this.store.room(roomId).state : null;
        const same = state && state.room.ownerId === memberId && state.room.title === title && state.room.purpose === purpose
          && state.room.kind === kind && state.members[memberId]?.displayName === displayName;
        if (!same) fail(409, "room_exists", "That room id is already in use");
        return { roomId, ownerMemberId: memberId, identityId: identity.identityId, duplicate: true, next: roomCreateNext(roomId) };
      }
      // The creation budget is spent here, past the idempotency short-circuit,
      // because it is a budget on rooms created and a replay creates none.
      // Charging it above meant a client retrying a dropped response - the one
      // thing the roomId idempotency key exists for - paid for rooms it never
      // made: with the production capacity of 3 and a refill of one token per
      // eight hours, one real creation plus two identical retries locked the
      // identity out of creating rooms for eight hours. Flooding is already
      // bounded before this point by the per-address limit on the route, and
      // the duplicate lookup above is a single indexed read.
      const limit = this.createLimiter.check(identity.identityId);
      if (!limit.allowed) fail(429, "rate_limited", limit.message);
      const createdCount = this.store.db.prepare("SELECT count(*) AS n FROM agent_room_ownership WHERE identity_id=?").get(identity.identityId).n;
      if (createdCount >= AGENT_ROOM_LIMIT) fail(409, "pilot_limit", "Bounded pilot capacity reached; no room was created");
      const at = new Date(this.store.now()).toISOString();
      // The identity is its own founding member: member id = identity id,
      // full owner permission set (bootstrap owner path in addMember).
      this.store.initialize([
        event({ type: T.ROOM_CREATED, actorId: memberId, roomId, at, data: { roomId, ownerId: memberId, title, purpose, kind } }),
        event({ type: T.MEMBER_ADDED, actorId: memberId, roomId, at, data: { memberId, displayName, kind: "agent", permissions: [...PERMISSIONS], identityId: identity.identityId } })
      ]);
      // Link the identity so its pri_ secret authenticates to the new room.
      this.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identity.identityId, memberId, this.store.now());
      this.store.db.prepare("INSERT INTO agent_room_ownership(identity_id,room_id,created_at) VALUES(?,?,?)")
        .run(identity.identityId, roomId, this.store.now());
      return { roomId, ownerMemberId: memberId, identityId: identity.identityId, duplicate: false, next: roomCreateNext(roomId) };
    });
  }

  // Ownership appointment: the current owner transfers ownership to an
  // existing active member (human or agent). The ownership.transferred
  // event is the audit trail and a later transfer reverses it. Unknown and
  // inactive targets share a bare 404 so members cannot be enumerated.
  transfer(token, roomId, { toMemberId, reason } = {}, expectedSessionBinding = null) {
    if (typeof toMemberId !== "string" || !toMemberId) fail(422, "invalid_transfer", "toMemberId is required");
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 280)) fail(422, "invalid_transfer", "Transfer reason must be at most 280 characters");
    return this.store.transaction(() => {
      // Owner-only, checked up front so the HTTP surface answers 403
      // owner_required like the other owner-gated routes; the reducer keeps
      // its own guard for the generic command path.
      const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
      if (auth.member.id !== this.store.roomAuthority(roomId).ownerId) fail(403, "owner_required", "Only the Room owner may transfer ownership");
      let result;
      try {
        result = this.store.command(token, roomId, {
          id: randomUUID(), type: T.OWNERSHIP_TRANSFERRED,
          data: { toMemberId, ...(reason === undefined ? {} : { reason }) }
        }, expectedSessionBinding);
      }
      catch (error) {
        if (error.code === "command_rejected" && error.message === "Unknown member") fail(404, "unknown_member", "No such member");
        throw error;
      }
      // The actor was the owner (the reducer requires it), so it is the
      // previous owner; the event data names the new one.
      return { roomId, ownerId: result.event.data.toMemberId, previousOwnerId: result.event.actorId,
        sequence: result.sequence, duplicate: false };
    });
  }
}
