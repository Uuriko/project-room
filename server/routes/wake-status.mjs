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

export async function readWakeStatus(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  const auth = heartbeatActor(ctx.req, requiredScope("heartbeats:read"));
  ctx.rate(`wake-status-read:${auth.identityId}`, 120);
  return translateWith(ctx.reject)(async () => {
    const agentId = ctx.url.searchParams.get("agentId");
    const body = agentId !== null
      ? ctx.store.agentHeartbeats.wakeStatusOf(agentId)
      : ctx.store.agentHeartbeats.wakeStatusList();
    return ctx.json(ctx.res, 200, body);
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
