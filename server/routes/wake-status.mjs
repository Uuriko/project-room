// plan-wake-live: GET /api/wake-status — who is actually listening.
//
// Wakeable = the agent polled (GET /api/agent-wakes/poll) or heartbeated
// within 24h. The response carries the wakeable list and the not-wakeable
// list; ?agentId= checks one agent. This is the data side for the
// COMMS-02 mention-target-warning surface: warn the poster when an
// @mention targets a not-wakeable agent.
//
// Route-table row (batch RT): the OpenAPI route gate forbids new
// legacy-chain registrations (the legacy allowlist only shrinks), so the
// route lives here, not in server/agent-plugin-routes.mjs. Auth reuses the
// plugin routes' agent-credential factories (pri_ identity secret with
// full permissions, rak_ API key with the heartbeats:read scope, or a
// room access token) — no duplicated credential logic.

import { createHeartbeatActor, translateWith, requiredScope } from "../agent-plugin-routes.mjs";

// Instinct-3 review (PR #1565): exact lastPolledAt is activity
// fingerprinting — the HTTP surface coarsens to { agentId, wakeable } and
// never serves raw poll timestamps. Server-side consumers (the COMMS-02
// mention-target warning) use the exact in-process
// store.agentHeartbeats.wakeStatusOf/wakeStatusList instead.
const coarsen = wakeable => entry => Object.freeze({ agentId: entry.agentId, wakeable });

export async function readWakeStatus(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  const auth = heartbeatActor(ctx.req, requiredScope("heartbeats:read"));
  ctx.rate(`wake-status-read:${auth.identityId}`, 120);
  return translateWith(ctx.reject)(async () => {
    const agentId = ctx.url.searchParams.get("agentId");
    if (agentId !== null) {
      const status = ctx.store.agentHeartbeats.wakeStatusOf(agentId);
      return ctx.json(ctx.res, 200,
        { agentId: status.agentId, wakeable: status.wakeable, windowMs: status.windowMs });
    }
    const list = ctx.store.agentHeartbeats.wakeStatusList();
    return ctx.json(ctx.res, 200, {
      windowMs: list.windowMs, asOf: list.asOf,
      wakeable: Object.freeze(list.wakeable.map(coarsen(true))),
      notWakeable: Object.freeze(list.notWakeable.map(coarsen(false))),
    });
  })();
}

const query = Object.freeze({ type: "object",
  properties: { agentId: { type: "string", description: "Check one agent instead of listing all" } } });

export const WAKE_STATUS_ROUTES = Object.freeze([
  Object.freeze({ id: "wake-status", method: "GET", path: "/api/wake-status",
    auth: "bearer", capability: null, scope: "directory", handler: readWakeStatus,
    schema: { query, response: { type: "object" } },
    events: [] }),
]);
