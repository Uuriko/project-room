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
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";
import { buildWorkClaimPage, handleWorkClaims } from "../work-claim-routes.mjs";

function requireRoomScope(ctx, auth, writing = false) {
  const required = writing ? "rooms:write" : "rooms:read";
  if (auth.kind !== "api-key") return;
  const granted = (auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*");
  if (!granted) ctx.reject(403, "insufficient_scope", "API key lacks the rooms:read scope");
}

function authenticateRead(ctx, writing = false) {
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

export async function provenanceRoute(ctx) {
  const writing = ctx.req.method === "POST";
  const { roomId, auth } = authenticateRead(ctx, writing);
  return handleWorkClaims({ req: ctx.req, res: ctx.res, url: ctx.url, store: ctx.store,
    roomId, auth, workClaimRoute: writing ? "premise-invalid" : "provenance", workClaimId: ctx.params.claimId,
    registry: ctx.store.workClaims, reauthorize: () => authenticateRead(ctx, writing).auth,
    helpers: { json: ctx.json, reject: ctx.reject, body: ctx.body } });
}

const parameters = Object.freeze({ type: "object", required: ["roomId"],
  properties: { roomId: { type: "string" } } });

// Deliberately non-punitive: queues for reviewers, never strikes or sanctions.
export const WORK_CLAIM_ROUTES = Object.freeze([
  ...["GET", "HEAD", "POST"].map(method => Object.freeze({ id: `claim-provenance-${method}`, method,
    path: `/api/rooms/{roomId}/work-claims/{claimId}/${method === "POST" ? "premise-invalid" : "provenance"}`,
    auth: "room", capability: null, scope: "room", handler: provenanceRoute,
    schema: { params: { type: "object", required: ["roomId", "claimId"], properties: { roomId: { type: "string" }, claimId: { type: "string" } } }, response: { type: "object" } }, events: [] })),
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
