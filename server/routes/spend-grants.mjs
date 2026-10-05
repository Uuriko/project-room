// Spend-primitive MVP (qa4-spend-mvp-jill): per-agent spend grants.
// POST issues a grant (owner or grants:issue delegate; tier-gated and
// guest-denied inside). DELETE revokes (idempotent). GET reads the caller's
// own spend summary — withhold, never refuse: guests and grant-less members
// get { spend: null }. Agents request spend; they never self-issue.

import { issueSpendGrantRoute, revokeSpendGrantRoute, readSpendGrantRoute } from "../spend-grants.mjs";

function context(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  return { roomId, selected, fence };
}

export async function issueSpendGrant(ctx) {
  const { roomId, selected, fence } = context(ctx);
  const request = await ctx.body(ctx.req);
  const result = issueSpendGrantRoute(ctx.store, selected.token, roomId, request, fence);
  return ctx.json(ctx.res, 201, result);
}

export function revokeSpendGrant(ctx) {
  const { roomId, selected, fence } = context(ctx);
  const result = revokeSpendGrantRoute(ctx.store, selected.token, roomId, ctx.params.agentId, fence);
  return ctx.json(ctx.res, 200, result);
}

export function readOwnSpendGrant(ctx) {
  const { roomId, selected, fence } = context(ctx);
  const result = readSpendGrantRoute(ctx.store, selected.token, roomId, fence);
  return ctx.json(ctx.res, 200, result);
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
  additionalProperties: false,
  properties: {
    agentId: { type: "string" },
    capCents: { type: "string" },
    perTxCapCents: { type: "string" },
    allowlist: { type: "array", items: { type: "string" } },
    singleUse: { type: "boolean" },
    expiresAt: { type: "string" },
  },
});

const response = Object.freeze({ type: "object" });

export const SPEND_GRANT_ROUTES = Object.freeze([
  Object.freeze({ id: "issue-spend-grant", method: "POST", path: "/api/rooms/{roomId}/spend-grants",
    auth: "room", capability: "spend", scope: "room", handler: issueSpendGrant,
    schema: { params: roomIdParam, body: grantBody, response }, events: [] }),
  Object.freeze({ id: "revoke-spend-grant", method: "DELETE", path: "/api/rooms/{roomId}/spend-grants/{agentId}",
    auth: "room", capability: "spend", scope: "room", handler: revokeSpendGrant,
    schema: { params: agentIdParam, response }, events: [] }),
  Object.freeze({ id: "read-own-spend-grant", method: "GET", path: "/api/rooms/{roomId}/spend-grant",
    auth: "room", capability: "spend", scope: "room", handler: readOwnSpendGrant,
    schema: { params: roomIdParam, response }, events: [] }),
]);
