// Work-claim retention routes (batch RT).
//
// The first work-claims route to leave the legacy chain in server/http.mjs:
// the read-only retention dashboard (research brief 2026-09-28, agent-retention
// mechanics #1 and #2). The claim-path ack wiring stays in
// server/work-claim-routes.mjs — that is behavior on existing routes, not a
// new route, so it stays where the family lives.
//
// Auth mirrors the legacy work-claims chain exactly: room credential, fence,
// roomAuth, bearer/session checks, read rate limit, API-key rooms:read scope.
// The dispatcher 405s non-GET methods before this handler runs.

import { retentionReport } from "../retention-response.mjs";
import { buildWorkClaimPage } from "../work-claim-routes.mjs";

function requireRoomScope(ctx, auth) {
  if (auth.kind !== "api-key") return;
  const granted = (auth.apiKeyScopes ?? []).some(scope => scope === "rooms:read" || scope === "rooms:*");
  if (!granted) ctx.reject(403, "insufficient_scope", "API key lacks the rooms:read scope");
}

function authenticateRead(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") {
    ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  }
  if (!selected.bearer && auth.kind !== "session") {
    ctx.reject(401, "unauthenticated", "Browser session required");
  }
  ctx.rate(`read:${auth.credentialHash}`, 600);
  requireRoomScope(ctx, auth);
  const members = ctx.store.roomAuthority(roomId).members ?? {};
  const member = members[auth.member.id];
  if (!member || member.active === false) {
    ctx.reject(403, "not_member", `Member "${auth.member.id}" is not a member of room "${roomId}"`);
  }
  return { roomId, auth };
}

export async function getRetentionDashboard(ctx) {
  const { roomId } = authenticateRead(ctx);
  const now = typeof ctx.store.now === "function" ? ctx.store.now() : Date.now();
  return ctx.json(ctx.res, 200, retentionReport(ctx.store.workClaims.list(roomId), { now }));
}

export async function getWorkClaimsRead(ctx) {
  const { roomId, auth } = authenticateRead(ctx);
  const now = typeof ctx.store.now === "function" ? ctx.store.now() : Date.now();
  return ctx.json(ctx.res, 200, buildWorkClaimPage(ctx.store.workClaims.list(roomId), roomId,
    auth.member.id, ctx.url.searchParams, now));
}

const parameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });

// Deliberately non-punitive: queues for reviewers, never strikes or sanctions.
export const WORK_CLAIM_ROUTES = Object.freeze([
  // A sibling path deliberately cannot enter an older server's mutating
  // work-claims handler; unsupported servers fail rather than sweep leases.
  Object.freeze({ id: "work-claims-read", method: "GET", path: "/api/rooms/{roomId}/work-claims-read",
    auth: "room", capability: null, scope: "room", handler: getWorkClaimsRead,
    schema: { params: parameters, response: { type: "object" } },
    events: [] }),
  Object.freeze({ id: "work-claim-retention", method: "GET", path: "/api/rooms/{roomId}/work-claims/retention",
    auth: "room", capability: null, scope: "room", handler: getRetentionDashboard,
    schema: { params: parameters, response: { type: "object" } },
    events: [] }),
]);
