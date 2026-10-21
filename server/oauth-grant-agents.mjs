// AGENT-DOOR-AUTH stage 2: OAuth grant agent bindings.
//
// Principal model (provenance: Codex's decision under the standing
// delegation, muse-room seq 16576; agreed by Jill, seq 16573; built under
// John's 2026-10-20 close-out direction): an approved OAuth grant for a
// connector client acts as a separate agent member the approving human
// OWNS — never as the human. Stage 1 bound the grant to the human's own
// member (store.authenticateOAuthAccount); stage 2 swaps that binding at
// the three seams (store bind, REST roomAuth's oauth branch, MCP
// bindOAuthGrant) to the agent member bound here.
//
// One binding per (account, client): approval mints the agent identity on
// first use and binds it; later approvals re-bind the same identity.
// Removal is isolated in both directions:
// - removing the agent (this module's remove(), or an ordinary room-level
//   member removal) kills the grant without touching the human's account,
//   memberships, or credentials;
// - revoking the grant (provider-side) never touches the binding or the
//   identity — the owned agent is removed only by agent removal.
//
// The identity's own secret is minted with the identity and never leaves
// the server: the OAuth grant is the agent's only door, so a leaked
// refresh token cannot be converted into the identity's other doors.
import { randomUUID } from "node:crypto";
import { ServiceError, PILOT_LIMITS, activeMemberCount } from "./store.mjs";
import { refuseArchivedWrite } from "./room-lifecycle.mjs";
import { event, EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION, AGENT_INVITE_SAFE_PERMISSIONS, canInviteMembers } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { assertAdmissibleMemberName } from "./display-name-guard.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// First-party clients whose consent contract is account sign-in (the Mac
// app: "Sign in to the Mac app with this account") keep the stage-1
// account principal. Every other client is an agent-principal connector.
export const ACCOUNT_PRINCIPAL_CLIENTS = Object.freeze(["project-room-macos"]);

export const oauthGrantAgentsSchema = `
  CREATE TABLE IF NOT EXISTS oauth_grant_agents (
    account_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY(account_id, client_id)
  );
`;

const ensured = new WeakSet();
export function ensureOAuthGrantAgentsSchema(db) {
  if (ensured.has(db)) return;
  db.exec(oauthGrantAgentsSchema);
  ensured.add(db);
}

const rowOf = row => row === undefined || row === null ? null : Object.freeze({
  accountId: row.account_id,
  clientId: row.client_id,
  identityId: row.identity_id,
  displayName: row.display_name,
  createdAt: row.created_at,
  revokedAt: row.revoked_at ?? null,
});

export class OAuthGrantAgents {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  ensure() { ensureOAuthGrantAgentsSchema(this.db); }

  // The binding row for (account, client), live or revoked; null when the
  // pair was never approved.
  binding({ accountId, clientId }) {
    this.ensure();
    return rowOf(this.db.prepare(
      "SELECT * FROM oauth_grant_agents WHERE account_id=? AND client_id=?"
    ).get(accountId, clientId));
  }

  liveBinding({ accountId, clientId }) {
    const row = this.binding({ accountId, clientId });
    return row !== null && row.revokedAt === null ? row : null;
  }

  // Mint-or-bind at approval time. A live binding is returned as-is (bind,
  // never re-mint); a revoked or absent binding mints a FRESH identity —
  // a removed agent stays removed, and re-approval creates its successor.
  resolve({ accountId, clientId, clientName }) {
    this.ensure();
    const existing = this.liveBinding({ accountId, clientId });
    if (existing) {
      return Object.freeze({ identityId: existing.identityId, displayName: existing.displayName, created: false });
    }
    return this.store.transaction(() => {
      const ownerName = this.store.accountProfile(accountId).displayName;
      const clientLabel = typeof clientName === "string" && clientName.trim() ? clientName.trim() : clientId;
      const possessive = ownerName ? `${ownerName}'s ${clientLabel}` : clientLabel;
      const displayName = possessive.slice(0, 80);
      const identity = this.store.identities.create(displayName);
      const now = this.store.now();
      this.db.prepare(
        `INSERT INTO oauth_grant_agents(account_id, client_id, identity_id, display_name, created_at, revoked_at)
         VALUES(?,?,?,?,?,NULL)
         ON CONFLICT(account_id, client_id) DO UPDATE SET
           identity_id=excluded.identity_id, display_name=excluded.display_name,
           created_at=excluded.created_at, revoked_at=NULL`
      ).run(accountId, clientId, identity.identityId, displayName, now);
      return Object.freeze({ identityId: identity.identityId, displayName, created: true });
    });
  }

  // Whole-agent removal by the owning account: the binding is revoked,
  // the identity is revoked (its secret and anything minted under it stop
  // authenticating), its room members are deactivated and unlinked. The
  // human's account, memberships, sessions, and credentials are never
  // written here — isolation is by construction, not by cleanup.
  remove({ accountId, clientId }) {
    this.ensure();
    const row = this.binding({ accountId, clientId });
    if (!row || row.revokedAt !== null) {
      return Object.freeze({ removed: false, identityId: row?.identityId ?? null });
    }
    const identityId = row.identityId;
    return this.store.transaction(() => {
      const now = this.store.now();
      this.db.prepare("UPDATE oauth_grant_agents SET revoked_at=? WHERE account_id=? AND client_id=?")
        .run(now, accountId, clientId);
      const identityRow = this.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?")
        .get(identityId);
      if (identityRow && identityRow.revokedAt === null) {
        this.db.prepare("UPDATE agent_identities SET revoked_at=? WHERE identity_id=?").run(now, identityId);
      }
      // The same side-effects identities.revoke() performs: scoped API
      // keys and webhook subscriptions minted under the identity die
      // with it, and no rotation receipt may revive it.
      this.store.agentPlugin?.revokeApiKeysForIdentity?.(identityId);
      this.store.agentPlugin?.disableWebhooksForIdentity?.(identityId);
      this.db.prepare("DELETE FROM agent_identity_rotation_receipts WHERE identity_id=?").run(identityId);
      const links = this.db.prepare("SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?")
        .all(identityId);
      for (const link of links) {
        this.deactivateMember(link.roomId, link.memberId, accountId);
        this.db.prepare("DELETE FROM identity_links WHERE room_id=? AND identity_id=?").run(link.roomId, identityId);
      }
      return Object.freeze({ removed: true, identityId });
    });
  }

  // Deactivate one member by direct event application (the admitLinkAgent
  // write pattern), attributed to the owning account's human member in
  // that room — the owner removing their own agent.
  deactivateMember(roomId, memberId, ownerAccountId) {
    const room = this.store.room(roomId);
    const member = room.state.members[memberId];
    if (!member || member.active === false) return;
    const ownerRow = this.db.prepare("SELECT member_id AS memberId FROM member_accounts WHERE room_id=? AND account_id=?")
      .get(roomId, ownerAccountId);
    const actorId = ownerRow?.memberId ?? room.state.room.ownerId ?? memberId;
    const eventId = randomUUID();
    const incoming = event({
      id: eventId, idempotencyKey: eventId, roomId, actorId,
      type: T.MEMBER_ACCESS_CHANGED, at: new Date(this.store.now()).toISOString(),
      data: { memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false },
    });
    const state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
    const projection = this.store.storedProjection(roomId, state), sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
  }

  // Materialize the agent member in a room on first grant use, following
  // admitLinkAgent's mechanics: MEMBER_ADDED with memberId === identityId,
  // an identity_links row, and ownership stamped as accountableHumanId
  // (the owner's human member). Permissions are the owner's CURRENT
  // permissions intersected with the agent-invite safe set, so the grant
  // can never widen what the owner themselves could do, and never carries
  // admin permissions (manage_members / decide / write_external).
  ensureAgentMember({ roomId, identityId, displayName, ownerMember }) {
    return this.store.transaction(() => {
      const room = this.store.room(roomId);
      const linked = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?")
        .get(roomId, identityId);
      const member = (linked && room.state.members[linked.memberId]) ?? room.state.members[identityId];
      if (member) {
        // A removed member stays removed: the grant is dead in this room
        // until a room owner re-admits the agent through the normal doors.
        if (!member.active) fail(403, "access_denied", "The granted agent member is no longer active in this room");
        return member;
      }
      refuseArchivedWrite(room.state);
      // Room sovereignty: admitting a new member — even the owner's own
      // agent — requires the owner's member to hold invite authority in
      // this room (room owner, or manage_members / invite_member): the
      // same rule every other agent-admission door (invites, share links,
      // sponsored connections) traces to. Without it the bind denies
      // cleanly here instead of surfacing the membership reducer's throw;
      // the human's own access is unaffected.
      if (!canInviteMembers(room.state, ownerMember.id)) {
        fail(403, "access_denied", "This account's member cannot admit its agent to this Room");
      }
      if (room.sequence >= PILOT_LIMITS.eventsPerRoom || activeMemberCount(room.state.members) >= PILOT_LIMITS.membersPerRoom) {
        fail(409, "pilot_limit", "This room is full");
      }
      assertAdmissibleMemberName(displayName.trim(), room.state.members);
      const permissions = (ownerMember.permissions ?? []).filter(permission => AGENT_INVITE_SAFE_PERMISSIONS.includes(permission));
      const now = this.store.now();
      const eventId = randomUUID();
      const incoming = event({
        id: eventId, idempotencyKey: eventId, roomId, actorId: ownerMember.id,
        type: T.MEMBER_ADDED, at: new Date(now).toISOString(),
        data: {
          memberId: identityId, identityId, displayName: displayName.trim(), kind: "agent", permissions,
          // Ownership is stamped as accountability; the grant provenance
          // itself lives in the oauth_grant_agents binding row (joinedVia
          // is a guarded field that admits only "one-time-code").
          accountableHumanId: ownerMember.id,
          authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
        },
      });
      const state = { ...applyEventWithGrowth(room.state, incoming, growthCollector).state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      const projection = this.store.storedProjection(roomId, state), sequence = room.sequence + 1;
      if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) {
        fail(409, "pilot_limit", "Room storage limit reached; no data was changed. Ask the room owner to raise the room's limit, or try again later.");
      }
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, eventId, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identityId, identityId, now);
      return this.store.room(roomId).state.members[identityId];
    });
  }

  // Receiving status for the owner-facing sessions view (seq 16573: the
  // three states are distinct and mean different things).
  //   listening — a live listener lease: a host is holding the wake poll
  //     open for this identity right now (live observation).
  //   connected — a wakeable host was observed recently (fresh heartbeat,
  //     host state online) but no listener lease is live.
  //   pull-only — capability only: the grant exists, but nothing is
  //     observed listening; the agent receives by polling/calling itself.
  receivingStatus(identityId) {
    try {
      const lease = this.db.prepare(
        "SELECT 1 FROM agent_wake_listener_leases WHERE agent_id=? AND lease_expires_at>? LIMIT 1"
      ).get(identityId, this.store.now());
      if (lease) return "listening";
    } catch { /* listener table is created lazily; absent means no listener */ }
    try {
      const status = this.store.agentHeartbeats?.statusOf?.(identityId);
      if (status && status.hosts.some(host => host.state === "online" && host.mode === "wakeable")) return "connected";
    } catch { /* heartbeat tables absent on a fresh database */ }
    return "pull-only";
  }
}

// The provider hook factory — the ONE resolver shape, injected by
// server/http.mjs into the server's provider and reused verbatim by
// tests. Account-principal clients short-circuit; every other client
// mint-or-binds its owned agent identity at approval time.
export function createGrantAgentResolver(store, { accountPrincipalClients = ACCOUNT_PRINCIPAL_CLIENTS } = {}) {
  return ({ userId, clientId, clientName }) => {
    if (accountPrincipalClients.includes(clientId)) return Object.freeze({ accountPrincipal: true });
    const resolved = store.oauthGrantAgents.resolve({ accountId: userId, clientId, clientName });
    return Object.freeze({ agentIdentityId: resolved.identityId });
  };
}

// The removal check factory — the resolver's companion shape, injected by
// server/http.mjs into the provider and reused verbatim by tests. A
// binding that EXISTS and is revoked is a removed agent: the provider
// refuses its token verification, exchanges, and refreshes, so removal
// cannot be undone by a stale family re-binding a successor at refresh
// time. A pair with no binding was never approved (nothing was removed),
// and a live binding is ordinary — only the revoked state is a removal.
export function createGrantAgentRemovalCheck(store) {
  return ({ userId, clientId }) => {
    const binding = store.oauthGrantAgents.binding({ accountId: userId, clientId });
    return binding !== null && binding.revokedAt !== null;
  };
}
