// WAKE-S34: POST /api/agent-heartbeats/claim — the started door for
// the durable listener queue.
//
// The listener lease/claim layer (server/agent-heartbeats.mjs) decides
// WHO may drain a wake queue: a lease heartbeat issues a fencing
// token, claims mark a batch started under that token, and only an ack
// carrying the token (or a re-claim) settles the batch. Until now the
// claim step existed only in the store — no door reached it, so the
// started state was unusable by any real consumer. This route is that
// door, with the same credential and scope contract as the ack door
// (POST /api/agent-heartbeats/ack): the pri_ identity secret or a rak_
// API key with the heartbeats:report scope; a room-scoped credential
// claims only its bound room's queue; an identity credential naming a
// roomId must be a live agent member of that room (claimRoomScope
// mirrors the lease-acquisition rules, so claim never widens past
// lease). Claiming is not completion: claimed signals stay queued
// until acked, and their started state expires with the lease.
//
// Route-table row: the OpenAPI route gate forbids new legacy-chain
// registrations, so the route lives here, not in
// server/agent-plugin-routes.mjs. Auth reuses the plugin routes'
// agent-credential factories — no duplicated credential logic.

import { createHeartbeatActor, translateWith, requiredScope } from "../agent-plugin-routes.mjs";
import { claimRoomScope } from "../agent-listener-contract.mjs";
import { HeartbeatError } from "../agent-heartbeats.mjs";

export function authenticateWakeClaim(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  return heartbeatActor(ctx.req, requiredScope("heartbeats:report"));
}

export async function claimWakes(ctx) {
  const auth = authenticateWakeClaim(ctx);
  ctx.rate(`agent-heartbeat-claim:${auth.identityId}`, 120);
  const initialIdentity = auth.identityId;
  return translateWith(ctx.reject)(async () => {
    const data = await ctx.body(ctx.req);
    if (!data || typeof data !== "object" || Array.isArray(data)
        || !Object.hasOwn(data, "fencingToken")
        || !Object.keys(data).every(field => field === "fencingToken" || field === "limit" || field === "roomId"))
      throw new HeartbeatError(422, "invalid_wake_claim",
        "fencingToken is the accepted field; limit (1..50) and roomId are optional");
    if (typeof data.fencingToken !== "string" || data.fencingToken.length === 0)
      throw new HeartbeatError(422, "invalid_wake_claim", "fencingToken must be a non-empty string");
    if (data.limit !== undefined && (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > 50))
      throw new HeartbeatError(422, "invalid_wake_claim", "limit must be an integer between 1 and 50");
    return ctx.json(ctx.res, 200, ctx.store.transaction(() => {
      // Re-resolve inside the write lock, exactly like the ack door:
      // the credential that started the request must be the one whose
      // queue is claimed.
      const fresh = authenticateWakeClaim(ctx);
      if (fresh.identityId !== initialIdentity)
        throw new HeartbeatError(403, "identity_changed", "Credential identity changed during request");
      const roomId = claimRoomScope(ctx.store, fresh, data.roomId ?? null);
      return ctx.store.agentHeartbeats.claimWakeBatch({
        agentId: fresh.identityId, roomId, fencingToken: data.fencingToken, limit: data.limit ?? 50 });
    }));
  })();
}

const body = Object.freeze({ type: "object", required: ["fencingToken"], additionalProperties: false,
  properties: {
    fencingToken: { type: "string", minLength: 1, description: "The live listener lease's fencing token, from a listenerLease heartbeat" },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Batch size (oldest first). Default 50" },
    roomId: { type: "string", minLength: 1, description: "Room queue to claim; must match the lease's scope. Omit for the identity queue" },
  } });

export const WAKE_CLAIM_ROUTES = Object.freeze([
  Object.freeze({ id: "wake-claim", method: "POST", path: "/api/agent-heartbeats/claim",
    auth: "bearer", capability: null, scope: "directory", handler: claimWakes, authenticate: authenticateWakeClaim,
    schema: { body, response: { type: "object" } },
    parity: "mcp:heartbeat_claim",
    events: [] }),
]);
