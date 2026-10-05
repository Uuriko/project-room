// Per-agent capability grant edges (UFO-steal slice 1, RC-2026-09-27-2728).
//
// Thesis: the autonomy tier matrix (server/autonomy-tiers.mjs) is the coarse
// gate — it bounds what an agent may DO. Grant edges are the fine gate: an
// explicit per-agent edge from the room authority saying THIS agent may use
// THIS capability. Ported from UFO's connector_grant edges
// (ufo/runtime/access/grants.py:359, egress_resolver.py:65): edges bind to
// the target agent, and resolution derives the live set per call — a grant
// recorded mid-serve is live for the next request, never cached at boot.
//
// Composition (read this before wiring a new capability):
//   1. Tiers stay the coarse gate. enforceAutonomyTiers runs first and is
//      never overridden by a grant: a t1_readonly denial beats any edge.
//   2. #1166 guest-scope denials stay authoritative. Denials win over
//      grants, always: issueGrant refuses guest agent members outright,
//      and requireCapability denies guests fail-closed even if a row
//      somehow exists. A grant can never widen a guest beyond its pass.
//   3. Grants only ADD allow-edges on top. A grant-gated capability needs
//      tier-allow AND guest-allow AND a live edge. Grants never remove a
//      tier or guest denial.
//
// What this module deliberately does NOT do:
// - No grant-gating of existing routes. Each surface opts into
//   requireCapability when its lane is ready; slice 1 ships the mechanism,
//   the registry, and the owner/delegate management API. Nothing that
//   worked before needs a grant now.
// - No expiry reaper. Expiry is lazy: expired edges filter at resolution,
//   fail-closed. A sweeper is a later slice if the table ever needs one.
// - No sandbox enforcement: like tiers, grants do not pretend to arm
//   server/agent-sandbox.mjs.
//
// Rows are room-local (room sovereignty) and keyed (room_id, agent_id,
// capability): one live edge per agent per capability. Re-issue upserts and
// clears revoked_at — an explicit un-revoke by whoever may manage grants.
// Revocation stamps revoked_at (audit trail, not a delete) and bites on the
// agent's very next request because enforcement re-reads the table fresh
// every time.
//
// This module does not import server/store.mjs (store imports it); errors
// carry status and code like ServiceError and the router reads them as such.
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

// Closed capability vocabulary. Issuing a grant for any other name is
// refused (422 unknown_capability) so typo-grants can never silently do
// nothing. Later slices extend this set as surfaces opt into
// requireCapability; the withheld-catalog slice enumerates it.
export const GRANTABLE_CAPABILITIES = Object.freeze([
  // Delegate grant management: the holder may issue/revoke grant edges for
  // other agents. In slice 1 this edge is unscoped: the management gate
  // requires the bare grants:issue edge (a scoped edge does not satisfy an
  // unqualified check — fail-closed). The room owner holds this implicitly
  // and never needs the row.
  "grants:issue",
  // Spend: the holder may call priced MCP tools against a credit cap.
  // The money terms (cap, per-tx cap, allowlist, single-use) live in
  // server/spend-grants.mjs spend_grant_terms; this edge is the liveness
  // switch (revocation/expiry bite here). t1_readonly and guests can never
  // hold it — enforced in spend-grants.mjs at issuance and per call.
  "spend",
]);

// Per-agent capability grant edges. Created lazily — by the owner API and
// by grants:issue holders. Purely additive: no schema version bump,
// IF NOT EXISTS is idempotent.
export const GRANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_capability_grants (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  scope TEXT NULL,
  expires_at INTEGER NULL,
  revoked_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_agent_capability_grants_agent
  ON agent_capability_grants (room_id, agent_id);
`;

// Called from the writer boot path (next to ensureAutonomyTiersSchema in
// server/store.mjs): the table is purely additive, so no schema version
// bump. IF NOT EXISTS is idempotent.
export function ensureGrantsSchema(db) {
  db.exec(GRANTS_SCHEMA);
}

export class GrantError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new GrantError(status, code, message); };

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validMemberId = id => typeof id === "string" && MEMBER_ID_PATTERN.test(id);
// Scope narrows an edge: null/undefined = the whole capability; otherwise a
// colon-separated qualifier with an optional trailing ":*" wildcard, the
// same shape as the API-key scope check in server/http.mjs.
const SCOPE_PATTERN = /^[A-Za-z0-9_:\-.]+(?::\*)?$/;
const validScope = scope => scope === null || scope === undefined
  || (typeof scope === "string" && scope.length <= 128 && SCOPE_PATTERN.test(scope));

function validCapability(capability) {
  return typeof capability === "string" && GRANTABLE_CAPABILITIES.includes(capability);
}

// Does the edge's scope cover the required scope? Null edge scope covers
// everything; otherwise exact match or trailing-wildcard prefix, mirroring
// the API-key scope check in server/http.mjs.
export function scopeCovers(edgeScope, requiredScope) {
  if (edgeScope === null || edgeScope === undefined) return true;
  if (typeof requiredScope !== "string" || requiredScope.length === 0) return false;
  if (edgeScope.endsWith(":*")) return requiredScope.startsWith(edgeScope.slice(0, -1));
  return requiredScope === edgeScope;
}

function rowToGrant(row) {
  if (!row) return null;
  return Object.freeze({
    roomId: row.room_id,
    agentId: row.agent_id,
    capability: row.capability,
    grantedBy: row.granted_by,
    scope: row.scope ?? null,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
  });
}

// Fresh read, every time: no caching anywhere on this path, so a grant
// issued mid-serve is live for the agent's next request, and a revocation
// bites immediately. This is the liveness property.
export function resolveGrants(db, roomId, agentId, nowMs = Date.now()) {
  if (!db || typeof roomId !== "string" || !validMemberId(agentId)) return [];
  const rows = db.prepare(
    `SELECT * FROM agent_capability_grants
     WHERE room_id = ? AND agent_id = ?
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY capability`
  ).all(roomId, agentId, nowMs);
  return Object.freeze(rows.map(rowToGrant));
}

export function hasGrant(db, roomId, agentId, capability, { scope = null, nowMs = Date.now() } = {}) {
  if (!validCapability(capability)) return false;
  return resolveGrants(db, roomId, agentId, nowMs)
    .some(edge => edge.capability === capability && scopeCovers(edge.scope, scope ?? "*"));
}

// Issue (or re-issue) a grant edge. Owner/delegate primitive — callers must
// gate with requireGrantManagement first. Guests can never hold edges:
// issuance to a guest agent member is refused outright (a grant can never
// widen a guest beyond its pass scope). Re-issue upserts: it refreshes
// scope/expiry and clears revoked_at (explicit un-revoke).
export function issueGrant(db, roomId, agentId, capability, { grantedBy, scope = null, expiresAt = null, nowMs = Date.now() } = {}) {
  if (!db || typeof roomId !== "string") refuse(422, "invalid_grant", "roomId must be a string");
  if (!validMemberId(agentId)) refuse(422, "invalid_grant", "agentId must be a room member id");
  if (isGuestAgentMemberId(agentId))
    refuse(422, "grant_guest_forbidden", "Capability grants cannot widen guest passes; upgrade the pass instead");
  if (!validCapability(capability))
    refuse(422, "unknown_capability", `capability must be one of ${GRANTABLE_CAPABILITIES.join(", ")}`);
  if (!validMemberId(grantedBy)) refuse(422, "invalid_grant", "grantedBy must be a room member id");
  if (!validScope(scope)) refuse(422, "invalid_grant", "scope must be a colon-separated qualifier with optional :* wildcard, ≤128 chars");
  if (expiresAt !== null && !(Number.isSafeInteger(expiresAt) && expiresAt > nowMs))
    refuse(422, "invalid_grant", "expiresAt must be a future unix-ms timestamp or null");
  db.prepare(`INSERT INTO agent_capability_grants
      (room_id, agent_id, capability, granted_by, scope, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(room_id, agent_id, capability) DO UPDATE SET
        granted_by=excluded.granted_by, scope=excluded.scope,
        expires_at=excluded.expires_at, revoked_at=NULL`)
    .run(roomId, agentId, capability, grantedBy, scope ?? null, expiresAt, nowMs);
  return resolveGrants(db, roomId, agentId, nowMs).find(edge => edge.capability === capability) ?? null;
}

// Revoke a grant edge: stamps revoked_at (audit trail, not a delete).
// Idempotent — revoking a non-live edge returns null instead of throwing,
// so automation can revoke without read-before-write.
export function revokeGrant(db, roomId, agentId, capability, { nowMs = Date.now() } = {}) {
  if (!db || typeof roomId !== "string") refuse(422, "invalid_grant", "roomId must be a string");
  if (!validMemberId(agentId)) refuse(422, "invalid_grant", "agentId must be a room member id");
  if (!validCapability(capability))
    refuse(422, "unknown_capability", `capability must be one of ${GRANTABLE_CAPABILITIES.join(", ")}`);
  const info = db.prepare(`UPDATE agent_capability_grants
      SET revoked_at = ? WHERE room_id = ? AND agent_id = ? AND capability = ? AND revoked_at IS NULL`)
    .run(nowMs, roomId, agentId, capability);
  return info.changes > 0;
}

// The trust-boundary check. Call sites run the tier gate and the #1166
// guest-scope denial first; this adds the grant edge on top. Composition:
// tier-allow AND guest-allow AND live edge. Fail-closed on every axis:
//   - missing actor -> 401 (call sites authenticate first)
//   - humans -> pass (humans are never grant-restricted; mirrors tiers)
//   - room owner -> pass (ownership implies full authority)
//   - guest agents -> 403, always (denials win over grants; a row is inert)
//   - no live edge -> 403 capability_grant_required
export function requireCapability({ db, roomId, actor, capability, scope = null, state = null, nowMs = Date.now(), fail = refuse }) {
  if (!actor || typeof actor.id !== "string") fail(401, "unauthenticated", "Authenticate before capability checks");
  if (actor.kind !== "agent") return; // humans are never grant-restricted
  if (state?.room && actor.id === state.room.ownerId) return; // ownership implies full authority
  if (isGuestAgentMemberId(actor.id))
    fail(403, "grant_denied", "Guest passes cannot hold capability grants; a grant can never widen a guest beyond its scope");
  if (!validCapability(capability))
    fail(422, "unknown_capability", `capability must be one of ${GRANTABLE_CAPABILITIES.join(", ")}`);
  if (!hasGrant(db, roomId, actor.id, capability, { scope, nowMs }))
    fail(403, "capability_grant_required", `Agent ${actor.id} holds no live grant for capability ${capability}`);
}

// Gate for the grant management API itself (issue/revoke/list): the room
// owner, or a non-guest agent the tier allows holding a live grants:issue
// edge. Tier denial and guest denial both beat the edge.
export function requireGrantManagement({ db, roomId, state, actor, nowMs = Date.now(), fail = refuse }) {
  if (!actor || typeof actor.id !== "string") fail(401, "unauthenticated", "Authenticate before grant management");
  if (state?.room && actor.id === state.room.ownerId) return; // ownership implies full authority
  if (actor.kind !== "agent") fail(403, "owner_required", "Only the room owner or a grants:issue delegate can manage capability grants");
  enforceAutonomyTierForAction({ db, roomId, state, actor, action: "grants:manage", fail });
  if (isGuestAgentMemberId(actor.id))
    fail(403, "guest_scope_denied", "Guest members cannot manage capability grants");
  requireCapability({ db, roomId, actor, capability: "grants:issue", state, nowMs, fail });
}

function requireRoomMember(room, memberId) {
  if (!validMemberId(memberId)) refuse(422, "invalid_grant", "memberId must be a room member id");
  if (!room.state.members?.[memberId]) refuse(404, "member_not_found", `No member ${memberId} in this room`);
}

// GET /api/rooms/:roomId/agent-grants — owner or grants:issue delegate.
// Lists every grant edge in the room (live and revoked/expired, so the
// audit trail is visible).
export function listAgentGrants(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    requireGrantManagement({ db: store.db, roomId, state: room.state, actor: auth.member, nowMs });
    const rows = store.db.prepare(
      `SELECT * FROM agent_capability_grants WHERE room_id = ? ORDER BY agent_id, capability`
    ).all(roomId);
    return { roomId, grants: rows.map(rowToGrant), evaluatedThrough: room.sequence };
  });
}

// GET /api/rooms/:roomId/agent-capabilities — any authenticated member;
// agents see their own effective set: tier baseline, live grant edges,
// guest flag. The per-request trust-boundary read: grants resolve fresh
// here, so an edge issued mid-serve shows up without a restart.
export function getAgentCapabilities(store, token, roomId, expectedSessionBinding = null) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    const memberId = auth.member.id;
    const guest = auth.member.kind === "agent" && isGuestAgentMemberId(memberId);
    return {
      roomId,
      memberId,
      guest,
      grants: guest ? [] : resolveGrants(store.db, roomId, memberId, nowMs),
      evaluatedThrough: room.sequence,
    };
  });
}

// POST /api/rooms/:roomId/agent-grants — body { agentId, capability,
// scope?, expiresAt? }. Owner or grants:issue delegate (tier-gated,
// guest-denied).
export function issueAgentGrant(store, token, roomId, request, expectedSessionBinding = null) {
  if (!request || Array.isArray(request) || typeof request !== "object")
    refuse(422, "invalid_grant", "Supply { agentId, capability, scope?, expiresAt? }");
  const { agentId, capability, scope = null, expiresAt = null } = request;
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    requireGrantManagement({ db: store.db, roomId, state: room.state, actor: auth.member, nowMs });
    requireRoomMember(room, agentId);
    const edge = issueGrant(store.db, roomId, agentId, capability,
      { grantedBy: auth.member.id, scope, expiresAt, nowMs });
    return { roomId, grant: edge, evaluatedThrough: store.room(roomId).sequence };
  });
}

// DELETE /api/rooms/:roomId/agent-grants/:agentId/:capability — revoke.
// Owner or grants:issue delegate (tier-gated, guest-denied). Idempotent.
export function revokeAgentGrant(store, token, roomId, agentId, capability, expectedSessionBinding = null) {
  return store.transaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const room = store.room(roomId);
    const nowMs = store.now();
    requireGrantManagement({ db: store.db, roomId, state: room.state, actor: auth.member, nowMs });
    requireRoomMember(room, agentId);
    const revoked = revokeGrant(store.db, roomId, agentId, capability, { nowMs });
    return { roomId, agentId, capability, revoked, evaluatedThrough: store.room(roomId).sequence };
  });
}

