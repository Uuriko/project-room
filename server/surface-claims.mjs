// Surface claims: the room-native Claim primitive (CLAIM-PRIM).
//
// Spec: ~/workspace/migration-2026-10-21/mig-primitives.md, Primitive 1. A
// claim is the fleet's mutual-exclusion primitive, moved off prose on a
// GitHub issue into a room object:
//
//   Claim { id, holderSeat, scope, claimedAt, expiresAt, heartbeatAt, state }
//
// scope is the typed union observed in practice — { prs }, { issues },
// { branch }, { surfaces }, { lane }, { room }, { names } — one claim may
// carry several dimensions. state ∈ active | released | expired |
// superseded. Amend is an in-place scope replacement with the prior scope
// kept in history; a close-out is release with a reason string.
//
// Expiry is server-enforced and presence-driven: a claim dies at
// min(expiresAt, lastPresence + CLAIM_PRESENCE_GRACE_MS), where
// lastPresence is the holder's latest heartbeat-presence signal in the room
// (agent host heartbeat via identity link, or room activity) read live at
// evaluation time. A live holder's heartbeats therefore renew the presence
// leg automatically; a holder who goes silent loses the claim on the grace
// cadence instead of holding it stale for the whole window — the dead-lane
// failure class the prose convention could not solve. Expiry transitions
// are persisted lazily by every operation (sweep first, then act), so a
// claim never reads active past its effective expiry.
//
// Conflict is information, not an error wall: a claim attempt on a held
// subject fails 409 surface_claim_held with the held claim (holder named)
// in the error detail. The same holder re-claiming a subject they hold
// supersedes their own claim instead.
//
// No new identities and no new task engine (programme law): claims bind to
// existing room members and link to existing work by reference only.

import { randomUUID } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { memberCan } from "../src/events.js";

export const CLAIM_PRESENCE_GRACE_MS = 15 * 60_000;
export const DEFAULT_CLAIM_WINDOW_MINUTES = 90;
export const MAX_CLAIM_WINDOW_MINUTES = 24 * 60;
const MAX_HISTORY = 50;

export class SurfaceClaimError extends ServiceError {
  constructor(status, code, message, detail = null) {
    super(status, code, message);
    if (detail) this.detail = detail;
  }
}

const invalid = message => new SurfaceClaimError(422, "invalid_surface_claim", message);
const notFound = claimId => new SurfaceClaimError(404, "surface_claim_not_found", `No surface claim "${claimId}" in this room`);

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const cleanText = (value, label, max) => {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid(`${label} must be a trimmed string of 1 to ${max} characters, without control characters`);
  }
  return value;
};

// Path grammar mirrors claim-scopes.mjs: explicit relative paths, a folder
// followed by /**, or ** for the whole repository.
function pathScope(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\x00-\x1f\x7f\\]/.test(value)) {
    throw invalid("Surfaces use explicit relative paths or a folder followed by /**.");
  }
  if (value === "**") return { path: "", subtree: true };
  const subtree = value.endsWith("/**");
  const path = (subtree ? value.slice(0, -3) : value).replace(/^\.\//, "");
  if (!path || /[*?[\]{}]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw invalid("Surfaces use explicit relative paths, folder/**, or ** for the whole repository.");
  }
  return { path, subtree };
}
const covers = (scope, other) => scope.path === other.path || (scope.subtree && (!scope.path || other.path.startsWith(scope.path + "/")));
const surfaceText = scope => scope.subtree ? (scope.path ? `${scope.path}/**` : "**") : scope.path;

function numberList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw invalid(`${label} must be an array of 1 to 50 numbers`);
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry < 1 || entry > 100_000_000) throw invalid(`${label} entries must be integers from 1 to 100000000`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function stringList(value, label, max) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw invalid(`${label} must be an array of 1 to 20 strings`);
  return [...new Set(value.map(entry => cleanText(entry, label, max)))];
}

// Validate + normalize a scope. Returns a fresh object carrying only the
// dimensions present; throws SurfaceClaimError(422) on any bad shape.
export function normalizeClaimScope(scope) {
  if (!isPlainObject(scope)) throw invalid("scope must be an object with at least one of: prs, issues, branch, surfaces, lane, room, names");
  const allowed = new Set(["prs", "issues", "branch", "surfaces", "lane", "room", "names"]);
  for (const key of Object.keys(scope)) if (!allowed.has(key)) throw invalid(`Unknown scope dimension "${key}"`);
  const out = {};
  if (scope.prs !== undefined) out.prs = numberList(scope.prs, "prs");
  if (scope.issues !== undefined) out.issues = numberList(scope.issues, "issues");
  if (scope.branch !== undefined) out.branch = cleanText(scope.branch, "branch", 200);
  if (scope.surfaces !== undefined) {
    if (!Array.isArray(scope.surfaces) || scope.surfaces.length < 1 || scope.surfaces.length > 50) throw invalid("surfaces must be an array of 1 to 50 paths");
    out.surfaces = [...new Set(scope.surfaces.map(entry => surfaceText(pathScope(entry))))];
  }
  if (scope.lane !== undefined) out.lane = cleanText(scope.lane, "lane", 64);
  if (scope.room !== undefined) {
    if (scope.room !== true) throw invalid("room must be true when present");
    out.room = true;
  }
  if (scope.names !== undefined) out.names = stringList(scope.names, "names", 120);
  if (Object.keys(out).length === 0) throw invalid("scope must claim at least one subject: prs, issues, branch, surfaces, lane, room, or names");
  return out;
}

// Do two normalized scopes claim the same subject anywhere?
export function scopesIntersect(a, b) {
  if (a.prs && b.prs && a.prs.some(n => b.prs.includes(n))) return true;
  if (a.issues && b.issues && a.issues.some(n => b.issues.includes(n))) return true;
  if (a.branch && b.branch && a.branch === b.branch) return true;
  if (a.lane && b.lane && a.lane.toLowerCase() === b.lane.toLowerCase()) return true;
  if (a.room && b.room) return true;
  if (a.names && b.names) {
    const lowered = new Set(b.names.map(name => name.toLowerCase()));
    if (a.names.some(name => lowered.has(name.toLowerCase()))) return true;
  }
  if (a.surfaces && b.surfaces) {
    const left = a.surfaces.map(pathScope);
    const right = b.surfaces.map(pathScope);
    if (left.some(scope => right.some(other => covers(scope, other) || covers(other, scope)))) return true;
  }
  return false;
}

const iso = ms => new Date(ms).toISOString();

// The effective expiry of a claim given the holder's latest presence signal
// (ms, or null when the holder has no presence signal on record).
export function effectiveExpiresAt(claim, presenceAtMs) {
  const lastPresence = Math.max(claim.heartbeatAt ?? 0, presenceAtMs ?? 0);
  return Math.min(claim.expiresAt, lastPresence + CLAIM_PRESENCE_GRACE_MS);
}

export function serializeClaim(claim, presenceAtMs, now) {
  const effective = claim.state === "active" ? effectiveExpiresAt(claim, presenceAtMs) : null;
  return {
    id: claim.id,
    holder: { memberId: claim.holderMemberId, displayName: claim.holderDisplayName, kind: claim.holderKind },
    scope: claim.scope,
    note: claim.note,
    state: claim.state,
    claimedAt: iso(claim.claimedAt),
    expiresAt: iso(claim.expiresAt),
    heartbeatAt: iso(Math.max(claim.heartbeatAt ?? 0, presenceAtMs ?? 0)),
    ...(effective !== null ? { effectiveExpiresAt: iso(effective) } : {}),
    releasedAt: claim.releasedAt ? iso(claim.releasedAt) : null,
    releaseReason: claim.releaseReason,
    supersededBy: claim.supersededBy,
    supersedes: claim.supersedes ?? [],
    history: (claim.history ?? []).map(entry => ({ ...entry, at: iso(entry.at) })),
  };
}

function windowMinutesOf(input) {
  const value = input.windowMinutes ?? DEFAULT_CLAIM_WINDOW_MINUTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CLAIM_WINDOW_MINUTES) {
    throw invalid(`windowMinutes must be an integer from 1 to ${MAX_CLAIM_WINDOW_MINUTES}`);
  }
  return value;
}

function noteOf(input, required = false) {
  if (input.note === undefined) {
    if (required) throw invalid("note is required");
    return null;
  }
  if (input.note === null) return null;
  return cleanText(input.note, "note", 500);
}

// Ops environment: { registry, presenceAt(roomId, memberId) -> ms|null,
// member(roomId, memberId) -> {id, displayName, kind, active}|null,
// canManageClaims(roomId, memberId) -> bool, now() -> ms }.
function sweepExpired(env, roomId, claims, now) {
  for (const claim of claims) {
    if (claim.state !== "active") continue;
    if (now > effectiveExpiresAt(claim, env.presenceAt(roomId, claim.holderMemberId))) {
      claim.state = "expired";
      claim.history = [...(claim.history ?? []), { at: now, action: "expired", by: null }].slice(-MAX_HISTORY);
      env.registry.set(roomId, claim);
    }
  }
}

function loadRoom(env, roomId) {
  const claims = env.registry.list(roomId);
  sweepExpired(env, roomId, claims, env.now());
  return claims;
}

function requireMember(env, roomId, memberId) {
  const member = env.member(roomId, memberId);
  if (!member || member.active === false) {
    throw new SurfaceClaimError(403, "not_member", `Member "${memberId}" is not a member of room "${roomId}"`);
  }
  return member;
}

export function takeSurfaceClaim(env, roomId, holderMemberId, input) {
  if (!isPlainObject(input)) throw invalid("claim body must be an object");
  for (const key of Object.keys(input)) {
    if (!["scope", "note", "windowMinutes"].includes(key)) throw invalid(`Unknown claim field "${key}"`);
  }
  const holder = requireMember(env, roomId, holderMemberId);
  const scope = normalizeClaimScope(input.scope);
  const note = noteOf(input);
  const windowMinutes = windowMinutesOf(input);
  return env.registry.transaction(() => {
    const now = env.now();
    const claims = loadRoom(env, roomId);
    const active = claims.filter(claim => claim.state === "active");
    const conflict = active.find(claim => claim.holderMemberId !== holderMemberId && scopesIntersect(claim.scope, scope));
    if (conflict) {
      throw new SurfaceClaimError(409, "surface_claim_held",
        `Subject is already claimed by ${conflict.holderDisplayName ?? conflict.holderMemberId} (claim ${conflict.id})`,
        { held: serializeClaim(conflict, env.presenceAt(roomId, conflict.holderMemberId), now) });
    }
    const own = active.filter(claim => claim.holderMemberId === holderMemberId && scopesIntersect(claim.scope, scope));
    const claim = {
      id: `sc_${randomUUID().replace(/-/g, "")}`,
      holderMemberId,
      holderDisplayName: holder.displayName ?? null,
      holderKind: holder.kind ?? null,
      scope, note,
      state: "active",
      claimedAt: now,
      expiresAt: now + windowMinutes * 60_000,
      heartbeatAt: now,
      releasedAt: null, releaseReason: null,
      supersededBy: null,
      supersedes: own.map(entry => entry.id),
      history: [{ at: now, action: "claimed", by: holderMemberId }],
    };
    for (const prior of own) {
      prior.state = "superseded";
      prior.supersededBy = claim.id;
      prior.history = [...(prior.history ?? []), { at: now, action: "superseded", by: holderMemberId }].slice(-MAX_HISTORY);
      env.registry.set(roomId, prior);
    }
    env.registry.set(roomId, claim);
    return { roomId, claim: serializeClaim(claim, now, now) };
  });
}

export function listSurfaceClaims(env, roomId, viewerMemberId, filter = {}) {
  requireMember(env, roomId, viewerMemberId);
  return env.registry.transaction(() => {
    const now = env.now();
    const claims = loadRoom(env, roomId);
    const state = filter.state ?? null;
    const mine = filter.mine === true;
    const listed = claims
      .filter(claim => (state === null || claim.state === state) && (!mine || claim.holderMemberId === viewerMemberId))
      .map(claim => serializeClaim(claim, env.presenceAt(roomId, claim.holderMemberId), now));
    return { roomId, claims: listed };
  });
}

export function getSurfaceClaim(env, roomId, viewerMemberId, claimId) {
  requireMember(env, roomId, viewerMemberId);
  return env.registry.transaction(() => {
    const now = env.now();
    loadRoom(env, roomId);
    const claim = env.registry.get(roomId, claimId);
    if (!claim) throw notFound(claimId);
    return { roomId, claim: serializeClaim(claim, env.presenceAt(roomId, claim.holderMemberId), now) };
  });
}

export function releaseSurfaceClaim(env, roomId, actorMemberId, claimId, input = {}) {
  if (!isPlainObject(input)) throw invalid("release body must be an object");
  for (const key of Object.keys(input)) if (key !== "reason") throw invalid(`Unknown release field "${key}"`);
  const reason = input.reason === undefined || input.reason === null ? null : cleanText(input.reason, "reason", 200);
  requireMember(env, roomId, actorMemberId);
  return env.registry.transaction(() => {
    const now = env.now();
    loadRoom(env, roomId);
    const claim = env.registry.get(roomId, claimId);
    if (!claim) throw notFound(claimId);
    if (claim.state !== "active") {
      throw new SurfaceClaimError(409, "surface_claim_closed", `Claim ${claimId} is ${claim.state} and cannot be released`);
    }
    if (claim.holderMemberId !== actorMemberId && !env.canManageClaims(roomId, actorMemberId)) {
      throw new SurfaceClaimError(403, "surface_claim_not_holder",
        "Only the holder, the room owner, or a member with manage_claims can release this claim");
    }
    claim.state = "released";
    claim.releasedAt = now;
    claim.releaseReason = reason;
    claim.history = [...(claim.history ?? []), { at: now, action: "released", by: actorMemberId }].slice(-MAX_HISTORY);
    env.registry.set(roomId, claim);
    return { roomId, claim: serializeClaim(claim, env.presenceAt(roomId, claim.holderMemberId), now) };
  });
}

export function amendSurfaceClaim(env, roomId, actorMemberId, claimId, input) {
  if (!isPlainObject(input)) throw invalid("amend body must be an object");
  for (const key of Object.keys(input)) {
    if (!["scope", "note", "windowMinutes"].includes(key)) throw invalid(`Unknown amend field "${key}"`);
  }
  if (input.scope === undefined && input.note === undefined && input.windowMinutes === undefined) {
    throw invalid("amend needs at least one of: scope, note, windowMinutes");
  }
  requireMember(env, roomId, actorMemberId);
  return env.registry.transaction(() => {
    const now = env.now();
    const claims = loadRoom(env, roomId);
    const claim = claims.find(entry => entry.id === claimId) ?? null;
    if (!claim) throw notFound(claimId);
    if (claim.state !== "active") {
      throw new SurfaceClaimError(409, "surface_claim_closed", `Claim ${claimId} is ${claim.state} and cannot be amended`);
    }
    if (claim.holderMemberId !== actorMemberId) {
      throw new SurfaceClaimError(403, "surface_claim_not_holder", "Only the holder can amend this claim");
    }
    const priorScope = claim.scope;
    if (input.scope !== undefined) {
      const scope = normalizeClaimScope(input.scope);
      const conflict = claims.find(entry => entry.state === "active" && entry.id !== claimId
        && entry.holderMemberId !== actorMemberId && scopesIntersect(entry.scope, scope));
      if (conflict) {
        throw new SurfaceClaimError(409, "surface_claim_held",
          `Subject is already claimed by ${conflict.holderDisplayName ?? conflict.holderMemberId} (claim ${conflict.id})`,
          { held: serializeClaim(conflict, env.presenceAt(roomId, conflict.holderMemberId), now) });
      }
      claim.scope = scope;
    }
    if (input.note !== undefined) claim.note = noteOf(input);
    if (input.windowMinutes !== undefined) claim.expiresAt = now + windowMinutesOf(input) * 60_000;
    claim.heartbeatAt = now; // amending is the holder acting: a presence signal
    claim.history = [...(claim.history ?? []),
      { at: now, action: "amended", by: actorMemberId, priorScope }].slice(-MAX_HISTORY);
    env.registry.set(roomId, claim);
    return { roomId, claim: serializeClaim(claim, now, now) };
  });
}

// Build the ops environment from a RoomStore. Presence = the holder's
// latest heartbeat-presence signal in the room (store.surfaceClaimPresenceAt:
// agent host heartbeat via identity link, or latest room activity).
export function surfaceClaimEnv(store) {
  return {
    registry: store.surfaceClaims,
    presenceAt: (roomId, memberId) => store.surfaceClaimPresenceAt(roomId, memberId),
    member: (roomId, memberId) => store.roomAuthority(roomId).members?.[memberId] ?? null,
    canManageClaims: (roomId, memberId) => {
      const authority = store.roomAuthority(roomId);
      if (authority.ownerId === memberId) return true;
      try { return memberCan(store.room(roomId).state, memberId, "manage_claims"); }
      catch { return false; }
    },
    now: () => store.now(),
  };
}
