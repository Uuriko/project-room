// Spend-primitive MVP (qa4-spend-mvp-jill): per-agent spend grants.
// POST issues a grant (owner or grants:issue delegate; tier-gated and
// guest-denied inside; delegates never self-issue — 403
// spend_grant_self_issue_forbidden — while the owner keeps full
// authority). DELETE revokes (idempotent). GET reads the caller's
// own spend summary — withhold, never refuse: guests and grant-less members
// get { spend: null }. Delegates request spend for other agents, never for
// themselves; the owner keeps full authority.

import { issueSpendGrantRoute, revokeSpendGrantRoute, readSpendGrantRoute, readSpendDefaultRoute, setSpendDefaultRoute } from "../spend-grants.mjs";

// Auth mirrors every sibling room route (#2955): room credential, fence,
// roomAuth, no Bearer account sessions, no non-session credentials carried
// by cookie, API-key rooms:read / rooms:write scope, then — for writes —
// protectWrite (Origin + CSRF) and the shared rate buckets before any
// mutation. roomCredentials falls back to ambient cookie tokens, so without
// this chain a cross-site cookie POST could mint or revoke spend grants.
function access(ctx, { writing }) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (auth.kind === "api-key") {
    const required = writing ? "rooms:write" : "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
  }
  if (writing) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  } else {
    ctx.rate(`read:${auth.credentialHash}`, 600);
  }
  return { roomId, selected, fence };
}

export async function issueSpendGrant(ctx) {
  const { roomId, selected, fence } = access(ctx, { writing: true });
  const request = await ctx.body(ctx.req);
  const result = issueSpendGrantRoute(ctx.store, selected.token, roomId, request, fence);
  return ctx.json(ctx.res, 201, result);
}

export function revokeSpendGrant(ctx) {
  const { roomId, selected, fence } = access(ctx, { writing: true });
  const result = revokeSpendGrantRoute(ctx.store, selected.token, roomId, ctx.params.agentId, fence);
  return ctx.json(ctx.res, 200, result);
}

export function readOwnSpendGrant(ctx) {
  const { roomId, selected, fence } = access(ctx, { writing: false });
  const result = readSpendGrantRoute(ctx.store, selected.token, roomId, fence);
  return ctx.json(ctx.res, 200, result);
}

export function readSpendDefault(ctx) {
  const { roomId, selected, fence } = access(ctx, { writing: false });
  const result = readSpendDefaultRoute(ctx.store, selected.token, roomId, fence);
  return ctx.json(ctx.res, 200, result);
}

export async function setSpendDefault(ctx) {
  const { roomId, selected, fence } = access(ctx, { writing: true });
  const request = await ctx.body(ctx.req);
  const result = setSpendDefaultRoute(ctx.store, selected.token, roomId, request, fence);
  return ctx.json(ctx.res, result.duplicate ? 200 : 201, result);
}

const roomIdParam = Object.freeze({
  type: "object",
  required: ["roomId"],
  properties: { roomId: { type: "string" } },
});

const agentIdParam = Object.freeze({
  type: "object",
  required: ["roomId", "agentId"],
  properties: { roomId: { type: "string" }, agentId: { type: "string" } },
});

const grantBody = Object.freeze({
  type: "object",
  required: ["agentId", "capCents", "perTxCapCents"],
  additionalProperties: false,
  properties: {
    agentId: { type: "string" },
    capCents: { type: "string" },
    perTxCapCents: { type: "string" },
    allowlist: { type: "array", items: { type: "string" } },
    singleUse: { type: "boolean" },
    // integer: the runtime gate (issueSpendGrant) requires a safe-integer
    // unix-ms timestamp. schemaErrors learned "integer" in the 2026-10-04
    // bughunt fix; "number" was only ever a workaround for the missing type.
    expiresAt: { type: "integer" },
  },
});

const spendDefaultBody = Object.freeze({
  type: "object",
  required: ["cents"],
  additionalProperties: false,
  properties: {
    // integer cents, or null to restore the built-in default; the runtime
    // gate (setSpendDefaultRoute) enforces the range.
    cents: { type: ["integer", "null"] },
    requestId: { type: "string" },
  },
});

const response = Object.freeze({ type: "object" });

export const SPEND_GRANT_ROUTES = Object.freeze([
  // capability is null like every other route row: the dispatcher never reads
  // it, and the real gate is requireGrantManagement inside each handler.
  // A non-null value here would imply an enforcement that does not exist.
  Object.freeze({ id: "issue-spend-grant", method: "POST", path: "/api/rooms/{roomId}/spend-grants",
    auth: "room", capability: null, scope: "room", handler: issueSpendGrant,
    schema: { params: roomIdParam, body: grantBody, response }, events: [] }),
  Object.freeze({ id: "revoke-spend-grant", method: "DELETE", path: "/api/rooms/{roomId}/spend-grants/{agentId}",
    auth: "room", capability: null, scope: "room", handler: revokeSpendGrant,
    schema: { params: agentIdParam, response }, events: [] }),
  Object.freeze({ id: "read-own-spend-grant", method: "GET", path: "/api/rooms/{roomId}/spend-grant",
    auth: "room", capability: null, scope: "room", handler: readOwnSpendGrant,
    schema: { params: roomIdParam, response }, events: [] }),
  // The member spend default (ruling 29b): capability is null like its
  // siblings — the real gate is the owner check inside setSpendDefaultRoute.
  // Parity is exempt: spend policy is REST-only — no MCP tool reads or sets
  // any spend-grant surface (the grant rows above predate the note rule).
  Object.freeze({ id: "read-spend-default", method: "GET", path: "/api/rooms/{roomId}/spend-default",
    auth: "room", capability: null, scope: "room", handler: readSpendDefault,
    parity: "exempt:spend policy is REST-only; no MCP twin for any spend surface",
    schema: { params: roomIdParam, response }, events: [] }),
  Object.freeze({ id: "set-spend-default", method: "POST", path: "/api/rooms/{roomId}/spend-default",
    auth: "room", capability: null, scope: "room", handler: setSpendDefault,
    parity: "exempt:spend policy is REST-only; no MCP twin for any spend surface",
    schema: { params: roomIdParam, body: spendDefaultBody, response }, events: [] }),
]);
