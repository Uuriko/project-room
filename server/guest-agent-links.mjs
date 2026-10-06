import { createHash, randomBytes } from "node:crypto";
import { EVENT_TYPES as T, event, validId } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { assessMemberDisplayName } from "./display-name-guard.mjs";

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
// Refresh grace window (issue #1563 review): an expired v0 credential can be
// self-refreshed only within this long after expiry. Without an age bound a
// token that expired months ago — or leaked into a log — would stay a
// perpetual re-entry ticket, turning the 2h TTL into "forever unless
// revoked". Past the window the guest needs a fresh owner invite.
export const GUEST_REFRESH_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
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
  if (kind !== "guest-agent") fail(410, "link_unavailable", "This guest invite is not valid.");
}

function displayNameOf(value) {
  const name = value === undefined ? GUEST_AGENT_DEFAULT_NAME : value;
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail(422, "invalid_link", "Choose a short guest name");
  }
  return name.trim();
}

// A mint that omits the name gets "Guest agent", then "Guest agent 2", and so
// on. The caller did not choose those words, so a retry of the same request
// still matches. An explicit name must match the stored one exactly.
function omittedGuestName(stored) {
  return stored === GUEST_AGENT_DEFAULT_NAME || stored.startsWith(`${GUEST_AGENT_DEFAULT_NAME} `);
}

function assignGuestName(requested, members, callerSuppliedName) {
  if (callerSuppliedName) return requested;
  const verdict = assessMemberDisplayName(requested, members);
  if (verdict.reason === "duplicate" && verdict.suggestion) return verdict.suggestion;
  return requested;
}

// Owner-issued vertical: no new table / writer bump. The link token is the
// ephemeral access credential. Anyone-with-link redeem storage stays deferred.
export class GuestAgentLinks {
  constructor(store) { this.store = store; this.db = store.db; }

  owner(token, roomId, binding) {
    // Owner delegates (server/owner-delegates.mjs) arrive via
    // store.authenticate with the delegate flag stamped on the member copy:
    // the journal keeps the delegate as the actor.
    const auth = this.store.authenticate(token, roomId, binding);
    // #643: owner-by-id — the owner capability follows the owner identity,
    // not the credential flavor (share-links-style owner-capability
    // exemption): an agent owner may mint guest links on their identity
    // bearer. The mint itself stays account-bound: guest member ids derive
    // from the sponsor account (see mint()).
    if (!auth.delegate && (auth.member?.id !== this.store.room(roomId).state.room.ownerId
      || !auth.member.permissions.includes("manage_members"))) {
      fail(403, "owner_required", "Only the room owner can mint a guest invite. Use Add agent for a durable key.");
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
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(tokenHash)) fail(409, "token_conflict", "Generate a new guest invite token");
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
    // A delegate's member record carries no manage_members, so store.command
    // (which re-authenticates from the token and would be rejected by the
    // reducer for the delegate actor) cannot run for it: the delegate flavor
    // below builds the same MEMBER_ACCESS_CHANGED events directly — the
    // same pattern as GuestInvites#deactivateGuestSeat — with the delegation
    // provenance recorded in the event data.
    const auth = this.store.authenticate(token, roomId, binding);
    if (auth.delegate) return this.sweepExpiredAsDelegate(roomId, auth);
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

  sweepExpiredAsDelegate(roomId, auth) {
    // The event model requires member.access_changed to be actor-attributed
    // to a member with manage_members, so the mechanical expiry sweep runs
    // as the room owner whose authority the delegate exercises (exactly as
    // the non-delegate sweep attributes to the minting owner). The real
    // actor and the delegation source ride explicitly in the event data;
    // the delegate's own mint stays credited to the delegate in
    // guest_invites.
    const ownerId = this.store.room(roomId).state.room.ownerId;
    const grantedBy = this.db.prepare(
      "SELECT granted_by FROM owner_delegate_grants WHERE room_id=? AND identity_id=? AND revoked_at IS NULL")
      .get(roomId, auth.identityId)?.granted_by ?? ownerId;
    const room = this.store.room(roomId);
    let state = room.state, sequence = room.sequence, swept = 0;
    for (const member of Object.values(room.state.members)) {
      if (!isGuestAgentMemberId(member.id) || member.kind !== GUEST_AGENT_KIND || member.active === false) continue;
      const row = this.db.prepare("SELECT hash,revoked,expires_at FROM credentials WHERE room_id=? AND member_id=? AND kind='access'").get(roomId, member.id);
      if (row && row.revoked === 0 && row.expires_at > this.store.now()) continue;
      const eventId = `guest-agent-end-${hash(`${member.id}:${row?.hash || "none"}`).slice(0, 40)}`;
      const incoming = event({
        id: eventId,
        idempotencyKey: eventId,
        roomId,
        actorId: ownerId,
        type: T.MEMBER_ACCESS_CHANGED,
        at: new Date(this.store.now()).toISOString(),
        data: { memberId: member.id, expectedMemberRevision: member.revision, active: false, permissions: member.permissions,
          // Delegation provenance as flat top-level keys: the event envelope
          // validator (src/events.js) only accepts plain objects for a
          // whitelisted set of keys, so the provenance rides as *Id-suffixed
          // strings, which the validator already checks with validId().
          delegatedSweepByMemberId: auth.member.id, delegatedSweepByIdentityId: auth.identityId,
          delegatedSweepGrantedBy: grantedBy },
      });
      try {
        state = { ...applyEventWithGrowth(state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      } catch (error) {
        fail(422, "command_rejected", error.message);
      }
      sequence += 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
      this.store.agentConnections.revokeMember(roomId, member.id);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, member.id);
      this.store.reminders.retireMember(roomId, member.id);
      swept += 1;
    }
    if (swept === 0) return;
    const projection = JSON.stringify(state);
    if (Buffer.byteLength(projection) > 4 * 1024 * 1000) fail(409, "pilot_limit", "Room storage limit reached");
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
  }

  mint(token, roomId, details, binding) {
    if (!details || Array.isArray(details) || typeof details !== "object") fail(422, "invalid_link", "Supply the guest invite mint fields");
    const allowed = ["requestId", "linkToken", "expectedOwnerRevision", "displayName", "roomId"];
    if (Object.keys(details).some(key => !allowed.includes(key))) fail(422, "invalid_link", "Supply the guest invite mint fields");
    const { requestId, linkToken, expectedOwnerRevision } = details;
    if (!validId(requestId) || (linkToken !== undefined && classifyJoinToken(linkToken) !== "guest-agent")
      || !Number.isSafeInteger(expectedOwnerRevision) || expectedOwnerRevision < 0) {
      fail(422, "invalid_link", "Supply a requestId and current owner revision; a guest token is optional");
    }
    if (details.roomId !== undefined && details.roomId !== roomId) fail(422, "invalid_link", "Room does not match this mint");
    const callerSuppliedName = details.displayName !== undefined;
    const displayName = displayNameOf(details.displayName);
    return this.store.transaction(() => {
      const auth = this.owner(token, roomId, binding);
      // Guest member ids derive from the sponsor account
      // (guestAgentMemberId): an accountless owner — e.g. an agent identity
      // bearer — passes the owner gate but cannot mint without an account.
      if (!auth.account) fail(403, "account_session_required", "Minting a guest invite requires a signed-in account session");
      if (expectedOwnerRevision !== auth.member.revision) fail(409, "stale_member_revision", "Your room permissions changed; refresh before minting");
      this.sweepExpired(token, roomId, binding);
      const memberId = guestAgentMemberId(auth.account.id, requestId);
      const existing = this.store.room(roomId).state.members[memberId];
      // Clients can omit linkToken: a CSPRNG token is issued once and only
      // its hash remains in storage. Legacy caller-provided tokens still work
      // during migration, but the owner must supply the exact same bytes on
      // a retry. A tokenless replay never discloses the original bearer.
      const issuedToken = linkToken ?? (existing ? null : GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url"));
      const prior = issuedToken ? this.credential(issuedToken) : null;
      if (existing) {
        if (!issuedToken) {
          if (existing.kind !== GUEST_AGENT_KIND || existing.active === false)
            fail(409, "membership_ended", "This guest membership ended; use a new requestId");
          const priorCredential = this.db.prepare("SELECT * FROM credentials WHERE room_id=? AND member_id=? AND kind='access'").get(roomId, memberId);
          const nameOk = callerSuppliedName ? existing.displayName === displayName : omittedGuestName(existing.displayName);
          if (!this.liveCredential(priorCredential, existing) || !nameOk)
            fail(409, "idempotency_conflict", "This requestId was already used for a different guest-agent mint");
          return { ...this.issued(null, priorCredential, existing, roomId), duplicate: true, replayed: true };
        }
        if (existing.kind !== GUEST_AGENT_KIND || existing.active === false) {
          fail(409, "membership_ended", "This guest membership ended; use a new requestId");
        }
        const nameOk = callerSuppliedName ? existing.displayName === displayName : omittedGuestName(existing.displayName);
        if (!prior || prior.room_id !== roomId || prior.member_id !== memberId || !this.liveCredential(prior, existing)
          || !nameOk) {
          fail(409, "idempotency_conflict", "This requestId was already used for a different guest-agent mint");
        }
        return { ...this.issued(issuedToken, prior, existing, roomId), duplicate: true };
      }
      if (this.liveCount(roomId) >= GUEST_AGENT_MAX_JOINS) fail(429, "rate_limited", "Guest-agent mint limit reached for this room; wait for expiry or disconnect one");
      if (this.db.prepare("SELECT count(*) n FROM credentials WHERE room_id=?").get(roomId).n >= 5000) fail(409, "pilot_limit", "Credential retention limit reached");
      this.conflict(hash(issuedToken));
      const assignedName = assignGuestName(displayName, this.store.room(roomId).state.members, callerSuppliedName);
      const membership = this.store.command(token, roomId, {
        id: `guest-agent-${hash(`${auth.account.id}:${requestId}`).slice(0, 40)}`,
        type: T.MEMBER_ADDED,
        data: { memberId, displayName: assignedName, kind: GUEST_AGENT_KIND, permissions: [...GUEST_AGENT_PERMISSIONS], accountableHumanId: auth.member.id }
      }, binding);
      const expiresAt = this.store.now() + GUEST_AGENT_TTL_MS;
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(issuedToken), roomId, memberId, expiresAt);
      const member = this.store.room(roomId).state.members[memberId];
      const row = this.credential(issuedToken);
      return { ...this.issued(issuedToken, row, member, roomId), membershipEventId: membership.event.id, duplicate: false };
    });
  }

  issued(linkToken, row, member, roomId) {
    return {
      ...(linkToken ? { token: linkToken } : {}),
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
      if (!this.liveCredential(row, member)) fail(410, "link_unavailable", "This guest invite is not valid.");
      return this.previewPublic(row, member);
    });
  }

  join(linkToken) {
    assertGuestAgentToken(linkToken);
    return this.store.transaction(() => {
      const row = this.credential(linkToken);
      const member = row && this.store.room(row.room_id).state.members[row.member_id];
      if (!this.liveCredential(row, member)) fail(410, "link_unavailable", "This guest invite is not valid.");
      const preview = this.previewPublic(row, member);
      return { ...preview, memberId: member.id, access: "read_chat" };
    });
  }

  // Self-service refresh for an EXPIRED v0 credential (issue #1563): no
  // owner round-trip. Possession of the expired token is the proof — it is
  // a 256-bit secret only the holder (and the minting store) ever saw.
  //
  // Tight scoping, and why:
  // - The old credential stays dead: a FRESH token is issued for the same
  //   seat and the old row is revoked. Burned codes are never resurrected.
  // - Revoked credentials never refresh: owner/admin revocation is final.
  // - A still-live credential is not refreshable (409): keep using it, or
  //   rotate() it for a leak response.
  // - An expired credential is refreshable only inside GUEST_REFRESH_GRACE_MS
  //   past expiry (410 credential_too_old beyond it): without an age bound a
  //   long-dead token would stay a perpetual re-entry ticket.
  // - v1 guest-invite seats (guest_members rows) are excluded: the v1
  //   credential TTL is the owner's leash (owner-settable 1h-14d); a
  //   self-serve refresh would let the guest extend it unilaterally, so v1
  //   stays owner-mediated through a fresh GX- code.
  // - A swept (deactivated) membership is not resurrected: the owner's
  //   eject stands; the guest needs a new invite.
  // - Same member, same room, same (empty) permissions, same fixed 2h TTL:
  //   refresh cannot escalate anything.
  // - Not idempotent: the new bearer is returned once, like mint. A repeat
  //   call finds the old row revoked and 410s — persist the new token.
  refresh(linkToken) {
    assertGuestAgentToken(linkToken);
    return this.store.transaction(() => {
      const row = this.credential(linkToken);
      const member = row && this.store.room(row.room_id).state.members[row.member_id];
      if (!row || !member || !isGuestAgentMemberId(member.id)) {
        fail(410, "link_unavailable", "This guest credential is not valid.");
      }
      if (this.db.prepare("SELECT 1 FROM guest_members WHERE member_id=?").get(member.id)) {
        fail(410, "invite_unavailable", "v1 guest-invite credentials refresh through a fresh owner code, not this endpoint.");
      }
      if (row.expires_at > this.store.now()) {
        fail(409, "credential_still_live", "This credential is still live; keep using it (rotate it if it leaked).");
      }
      if (this.store.now() - row.expires_at > GUEST_REFRESH_GRACE_MS) {
        fail(410, "credential_too_old", "This credential expired too long ago to refresh; ask the owner for a new invite.");
      }
      if (member.kind !== GUEST_AGENT_KIND || member.active === false) {
        fail(410, "membership_ended", "This guest membership ended; ask the owner for a new invite.");
      }
      if (row.revoked !== 0) {
        fail(410, "link_unavailable", "This guest credential was revoked and cannot be refreshed.");
      }
      const issuedToken = GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      this.conflict(hash(issuedToken));
      const expiresAt = this.store.now() + GUEST_AGENT_TTL_MS;
      this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)")
        .run(hash(issuedToken), row.room_id, member.id, expiresAt);
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(linkToken));
      return { ...this.issued(issuedToken, { expires_at: expiresAt }, member, row.room_id), refreshed: true };
    });
  }
}
