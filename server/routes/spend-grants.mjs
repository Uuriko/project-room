// Spend-primitive MVP (qa4-spend-mvp-jill): per-agent spend grants.
// POST issues a grant (owner or grants:issue delegate; tier-gated and
// guest-denied inside; delegates never self-issue — 403
// spend_grant_self_issue_forbidden — while the owner keeps full
// authority). DELETE revokes (idempotent). GET reads the caller's
// own spend summary — withhold, never refuse: guests and grant-less members
// get { spend: null }. Delegates request spend for other agents, never for
// themselves; the owner keeps full authority.

import { issueSpendGrantRoute, revokeSpendGrantRoute, readSpendGrantRoute } from "../spend-grants.mjs";

function context(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  return { roomId, selected, fence };
}

export async function issueSpendGrant(ctx) {
  const { roomId, selected, fence } = context(ctx);
  return ctx.json(ctx.res, 201, issueSpendGrantRoute(ctx.store, selected.token, roomId, await ctx.body(ctx.req), fence));
}

export function revokeSpendGrant(ctx) {
  const { roomId, selected, fence } = context(ctx);
  return ctx.json(ctx.res, 200, revokeSpendGrantRoute(ctx.store, selected.token, roomId, ctx.params.agentId, fence));
}

export function readOwnSpendGrant(ctx) {
  const { roomId, selected, fence } = context(ctx);
  return ctx.json(ctx.res, 200, readSpendGrantRoute(ctx.store, selected.token, roomId, fence));
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

const response = Object.freeze({ type: "object" });

// Local row builder: same frozen shape/keys as the hand-written rows; keeps the table one row per line.
const row=(id,method,path,handler,schema)=>Object.freeze({id,method,path,auth:"room",capability:null,scope:"room",handler,schema,events:[]});

export const SPEND_GRANT_ROUTES = Object.freeze([
  // capability is null like every other route row: the dispatcher never reads
  // it, and the real gate is requireGrantManagement inside each handler.
  // A non-null value here would imply an enforcement that does not exist.
  row("issue-spend-grant", "POST", "/api/rooms/{roomId}/spend-grants", issueSpendGrant,
    { params: roomIdParam, body: grantBody, response }),
  row("revoke-spend-grant", "DELETE", "/api/rooms/{roomId}/spend-grants/{agentId}", revokeSpendGrant,
    { params: agentIdParam, response }),
  row("read-own-spend-grant", "GET", "/api/rooms/{roomId}/spend-grant", readOwnSpendGrant,
    { params: roomIdParam, response }),
]);
