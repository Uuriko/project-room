// Surface-claim routes (CLAIM-PRIM, mig-primitives.md Primitive 1).
//
// The room-native Claim object: take / list / read / release / amend a
// room-scoped claim on a subject (PRs, issues, branch, repo surfaces, lane,
// the room, free-named work). The state machine lives in
// server/surface-claims.mjs over the durable registry in
// server/surface-claim-sqlite.mjs; these handlers are the HTTP door, with
// the MCP tools (room_claim_surface, room_list_surface_claims,
// room_release_surface_claim, room_amend_surface_claim) as the parity door.
//
// Auth mirrors the work-claims route chain: room credential, fence,
// roomAuth, bearer/session checks, read/write rate limits, API-key
// rooms:read / rooms:write scopes, guest-agent write refusal.

import { surfaceClaimEnv, takeSurfaceClaim, listSurfaceClaims, getSurfaceClaim, releaseSurfaceClaim, amendSurfaceClaim } from "../surface-claims.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";

function requireRoomScope(ctx, auth, writing = false) {
  const required = writing ? "rooms:write" : "rooms:read";
  if (auth.kind !== "api-key") return;
  const granted = (auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*");
  if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
}

function authenticate(ctx, writing = false) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") {
    ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  }
  if (!selected.bearer && auth.kind !== "session") {
    ctx.reject(401, "unauthenticated", "Browser session required");
  }
  ctx.rate(`read:${auth.credentialHash}`, 600);
  requireRoomScope(ctx, auth, writing);
  if (writing) {
    if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  const members = ctx.store.roomAuthority(roomId).members ?? {};
  const member = members[auth.member.id];
  if (!member || member.active === false) {
    ctx.reject(403, "not_member", `Member "${auth.member.id}" is not a member of room "${roomId}"`);
  }
  return { roomId, auth };
}

export async function takeSurfaceClaimRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 201, takeSurfaceClaim(surfaceClaimEnv(ctx.store), roomId, auth.member.id, body ?? {}));
}

export async function listSurfaceClaimsRoute(ctx) {
  const { roomId, auth } = authenticate(ctx);
  const filter = {
    state: ctx.url.searchParams.get("state") ?? undefined,
    mine: ctx.url.searchParams.get("mine") === "1" || ctx.url.searchParams.get("mine") === "true",
  };
  return ctx.json(ctx.res, 200, listSurfaceClaims(surfaceClaimEnv(ctx.store), roomId, auth.member.id, filter));
}

export async function getSurfaceClaimRoute(ctx) {
  const { roomId, auth } = authenticate(ctx);
  return ctx.json(ctx.res, 200, getSurfaceClaim(surfaceClaimEnv(ctx.store), roomId, auth.member.id, ctx.params.claimId));
}

export async function releaseSurfaceClaimRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, releaseSurfaceClaim(surfaceClaimEnv(ctx.store), roomId, auth.member.id, ctx.params.claimId, body ?? {}));
}

export async function amendSurfaceClaimRoute(ctx) {
  const { roomId, auth } = authenticate(ctx, true);
  const body = await ctx.body(ctx.req);
  return ctx.json(ctx.res, 200, amendSurfaceClaim(surfaceClaimEnv(ctx.store), roomId, auth.member.id, ctx.params.claimId, body ?? {}));
}

const roomParameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });
const claimParameters = Object.freeze({ type: "object", required: ["roomId", "claimId"],
  properties: { roomId: { type: "string" }, claimId: { type: "string" } } });
const scopeSchema = Object.freeze({ type: "object", properties: {
  prs: { type: "array" }, issues: { type: "array" }, branch: { type: "string" },
  surfaces: { type: "array" }, lane: { type: "string" }, room: { type: "boolean" }, names: { type: "array" } } });
const takeBody = Object.freeze({ type: "object", required: ["scope"], properties: {
  scope: scopeSchema, note: { type: "string" }, windowMinutes: { type: "integer" } } });
const amendBody = Object.freeze({ type: "object", properties: {
  scope: scopeSchema, note: { type: "string" }, windowMinutes: { type: "integer" } } });
const releaseBody = Object.freeze({ type: "object", properties: { reason: { type: "string" } } });

export const SURFACE_CLAIM_ROUTES = Object.freeze([
  Object.freeze({ id: "surface-claim-take", method: "POST", path: "/api/rooms/{roomId}/surface-claims",
    auth: "room", capability: null, scope: "room", handler: takeSurfaceClaimRoute,
    schema: { params: roomParameters, body: takeBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_claim_surface" }),
  Object.freeze({ id: "surface-claims-list", method: "GET", path: "/api/rooms/{roomId}/surface-claims",
    auth: "room", capability: null, scope: "room", handler: listSurfaceClaimsRoute,
    schema: { params: roomParameters, response: { type: "object" } }, events: [],
    parity: "mcp:room_list_surface_claims" }),
  Object.freeze({ id: "surface-claim-read", method: "GET", path: "/api/rooms/{roomId}/surface-claims/{claimId}",
    auth: "room", capability: null, scope: "room", handler: getSurfaceClaimRoute,
    schema: { params: claimParameters, response: { type: "object" } }, events: [],
    parity: "mcp:room_list_surface_claims" }),
  Object.freeze({ id: "surface-claim-release", method: "POST", path: "/api/rooms/{roomId}/surface-claims/{claimId}/release",
    auth: "room", capability: null, scope: "room", handler: releaseSurfaceClaimRoute,
    schema: { params: claimParameters, body: releaseBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_release_surface_claim" }),
  Object.freeze({ id: "surface-claim-amend", method: "POST", path: "/api/rooms/{roomId}/surface-claims/{claimId}/amend",
    auth: "room", capability: null, scope: "room", handler: amendSurfaceClaimRoute,
    schema: { params: claimParameters, body: amendBody, response: { type: "object" } }, events: [],
    parity: "mcp:room_amend_surface_claim" }),
]);
