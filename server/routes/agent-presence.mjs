// Presence Gap 4 (BUILD-PRESENCE-GAP4, D2 Charter A):
// GET /api/agents/{identityId}/presence — cross-room presence for one
// agent identity, restricted to the rooms the CALLER has standing in
// (a live member seat, or ownership of record). The per-room read
// (GET /api/rooms/{roomId}/presence) forces a coordinator who wants a
// seat's liveness across rooms to poll every room separately — and can
// say nothing about rooms it has not enumerated. This read answers the
// liveness question in one call: "is this identity present in any room
// I share with it, and when was its host last seen."
//
// The restriction is structural, not a handler filter: the store
// derivation (store.agentPresence) joins the target's seats against
// the caller's standing room by room, so a room the caller cannot
// stand in contributes no row. An identity sharing no room with the
// caller, an identity with no hosts, and an unknown identity id all
// return the same empty shape — the read never confirms an identity
// exists elsewhere. Rows are the per-room presence rows for the
// target's member in each shared room, derived from heartbeat
// evidence by the same code as the per-room read (watching is false:
// this read holds no stream).
//
// Route-table row (batch RT): the OpenAPI route gate forbids new
// legacy-chain registrations, so the route lives here. Auth reuses the
// plugin routes' agent-credential factories (pri_ identity secret with
// full permissions, rak_ API key with the heartbeats:read scope, or a
// room access token bound to its one room) — no duplicated credential
// logic.

import { createHeartbeatActor, translateWith, requiredScope } from "../agent-plugin-routes.mjs";

export function authenticateAgentPresence(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  return heartbeatActor(ctx.req, requiredScope("heartbeats:read"));
}

export async function readAgentPresence(ctx) {
  const auth = authenticateAgentPresence(ctx);
  ctx.rate(`agent-presence-read:${auth.identityId}`, 120);
  return translateWith(ctx.reject)(async () => {
    const result = ctx.store.agentPresence(
      { identityId: auth.identityId, boundRoomId: auth.roomId ?? null },
      ctx.params.identityId);
    return ctx.json(ctx.res, 200, result);
  })();
}

const parameters = Object.freeze({ type: "object", required: ["identityId"],
  properties: { identityId: { type: "string" } } });

export const AGENT_PRESENCE_ROUTES = Object.freeze([
  Object.freeze({ id: "agent-presence", method: "GET", path: "/api/agents/{identityId}/presence",
    auth: "bearer", capability: null, scope: "directory", handler: readAgentPresence, authenticate: authenticateAgentPresence,
    schema: { params: parameters, response: { type: "object" } },
    events: [], parity: "mcp:agent_presence" }),
]);
