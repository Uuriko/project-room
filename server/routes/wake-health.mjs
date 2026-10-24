// MIG-WAKE spec S7: GET /api/wake-health — one agent's wake health.
//
// The numbers (pending count, oldest pending age, last acked, journaled
// failures) already exist server-side in agent_wake_signals and the
// #3345 failure journal; this route serves them in one place so an
// agent or a coordinator can check wake health without auditing logs.
// What the stores do not keep per agent rides along as `gaps` (and
// counters/failureRate stay null) instead of being derived into
// existence — see server/wake-health.mjs.
//
// Permission shape (mirrors GET /api/wake-status's scoping, one step
// narrower because the values are one named agent's, exact stamps
// included): the caller authenticates with the same credential
// factories (pri_ identity secret with full permissions, rak_ API key
// with the heartbeats:read scope, or a room access token). Reading
// your OWN health is always allowed. Reading another agent's health
// requires a shared room: an identity credential must be linked into
// at least one room the target is linked into (identity_links
// co-membership), and a room access key reads only members of its
// bound room. Exact signal stamps are served inside that shape only —
// the wake-status list surface keeps its coarser contract.

import { createHeartbeatActor, translateWith, requiredScope } from "../agent-plugin-routes.mjs";
import { wakeHealthForAgent, WAKE_HEALTH_GAPS } from "../wake-health.mjs";

// Same id shape agent-heartbeats' checkAgentId enforces; checked here
// so a malformed ?agentId= 422s instead of throwing through the store.
const AGENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

function isRoomMember(store, roomId, identityId) {
  return !!store.db.prepare(
    "SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=? LIMIT 1").get(roomId, identityId);
}

function sharesRoom(store, identityId, otherIdentityId) {
  return !!store.db.prepare(
    `SELECT 1 FROM identity_links a JOIN identity_links b ON a.room_id = b.room_id
     WHERE a.identity_id=? AND b.identity_id=? LIMIT 1`).get(identityId, otherIdentityId);
}

export function authenticateWakeHealth(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  return heartbeatActor(ctx.req, requiredScope("heartbeats:read"));
}

export async function readWakeHealth(ctx) {
  const auth = authenticateWakeHealth(ctx);
  ctx.rate(`wake-health-read:${auth.identityId}`, 120);
  return translateWith(ctx.reject)(async () => {
    const target = ctx.url.searchParams.get("agentId") ?? auth.identityId;
    if (!AGENT_ID_SHAPE.test(target))
      ctx.reject(422, "invalid_heartbeat", "agentId must match [A-Za-z0-9_-]{1,64}");
    if (target !== auth.identityId) {
      if (auth.roomId) {
        if (!isRoomMember(ctx.store, auth.roomId, target))
          ctx.reject(403, "room_membership_required",
            "A room access key can only read wake health for members of its bound room");
      } else if (!sharesRoom(ctx.store, auth.identityId, target)) {
        ctx.reject(403, "room_membership_required",
          "You can read wake health only for agents who share a room with you");
      }
    }
    const status = ctx.store.agentHeartbeats.wakeStatusOf(target);
    const health = wakeHealthForAgent(ctx.store.db,
      { agentId: target, now: ctx.store.agentHeartbeats.now() });
    return ctx.json(ctx.res, 200, {
      agentId: target, asOf: health.asOf,
      wakeable: status.wakeable, windowMs: status.windowMs, lastPolledAt: status.lastPolledAt,
      signals: health.signals, failures: health.failures,
      counters: null, failureRate: null, gaps: WAKE_HEALTH_GAPS,
    });
  })();
}

const query = Object.freeze({ type: "object",
  properties: {
    agentId: { type: "string", description: "Agent (identity id) whose wake health to read; omit for your own. Another agent's health requires a shared room" },
  } });

export const WAKE_HEALTH_ROUTES = Object.freeze([
  Object.freeze({ id: "wake-health", method: "GET", path: "/api/wake-health",
    auth: "bearer", capability: null, scope: "directory", handler: readWakeHealth, authenticate: authenticateWakeHealth,
    parity: "exempt:per-agent wake-health read for agents and coordinators; no MCP tool serves wake counters — the MCP heartbeat surface serves the caller's own pending queue, not another agent's health",
    schema: { query, response: { type: "object" } },
    events: [] }),
]);
