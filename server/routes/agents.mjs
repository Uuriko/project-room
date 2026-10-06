// CP-AGENTS-1: GET /api/rooms/{roomId}/agents/overview, the fleet read model
// (server/agent-fleet.mjs). Read-only. The owner and delegated admins see
// every agent; a human sees the agents they sponsor; anyone else gets 403
// owner_required.

import { fleetFor } from "../agent-fleet.mjs";

function readContext(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:read" || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", "API key lacks rooms:read");
  }
  return { roomId, auth };
}

export function agentsOverview(ctx) {
  const { roomId, auth } = readContext(ctx);
  const overview = fleetFor(ctx.store, auth, roomId);
  if (!overview) ctx.reject(403, "owner_required", "Only the room owner, a delegated admin, or an agent's sponsor can read the agent overview");
  return ctx.json(ctx.res, 200, overview);
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });

export const AGENT_FLEET_ROUTES = Object.freeze([
  Object.freeze({ id: "agents-overview", method: "GET", path: "/api/rooms/{roomId}/agents/overview",
    auth: "room", capability: null, scope: "room", handler: agentsOverview,
    schema: { params: parameters, response: { type: "object" } },
    events: [] }),
]);
