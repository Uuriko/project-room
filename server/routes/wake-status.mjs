// plan-wake-live: GET /api/wake-status — who is actually listening.
//
// Wakeable = the agent polled (GET /api/agent-wakes/poll) or heartbeated
// within 24h. Two modes, both scoped (Instinct-3 review, PR #1565):
//   - no query params: the caller's own { agentId, wakeable, windowMs };
//   - ?roomId=: { wakeable[], notWakeable[] } for that room's members —
//     the data side for the COMMS-02 mention-target warning ("before I
//     @mention someone here, are they listening?").
// A room access key reads only its bound room; an identity credential must
// be a member of the room it asks about. Exact poll timestamps never leave
// the server (activity fingerprinting) — entries coarsen to
// { agentId, wakeable }. Server-side consumers use the exact in-process
// store.agentHeartbeats.wakeStatusOf/wakeStatusList instead.
//
// Route-table row (batch RT): the OpenAPI route gate forbids new
// legacy-chain registrations (the legacy allowlist only shrinks), so the
// route lives here, not in server/agent-plugin-routes.mjs. Auth reuses the
// plugin routes' agent-credential factories (pri_ identity secret with
// full permissions, rak_ API key with the heartbeats:read scope, or a
// room access token) — no duplicated credential logic.

import { createHeartbeatActor, translateWith, requiredScope } from "../agent-plugin-routes.mjs";

const coarsen = wakeable => entry => Object.freeze({ agentId: entry.agentId, wakeable });

function roomMemberIdentityIds(store, roomId) {
  return store.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=?")
    .all(roomId).map(row => row.identityId);
}

function isRoomMember(store, roomId, identityId) {
  return !!store.db.prepare(
    "SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=? LIMIT 1").get(roomId, identityId);
}

export function authenticateWakeStatus(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  return heartbeatActor(ctx.req, requiredScope("heartbeats:read"));
}

export async function readWakeStatus(ctx) {
  const auth = authenticateWakeStatus(ctx);
  ctx.rate(`wake-status-read:${auth.identityId}`, 120);
  return translateWith(ctx.reject)(async () => {
    const roomId = ctx.url.searchParams.get("roomId");
    // Caller-only mode: your own wakeability, always allowed.
    if (roomId === null) {
      const status = ctx.store.agentHeartbeats.wakeStatusOf(auth.identityId);
      return ctx.json(ctx.res, 200,
        { agentId: status.agentId, wakeable: status.wakeable, windowMs: status.windowMs });
    }
    // Room mode: wakeability for the room's members. Room access keys are
    // bound to their room; identity credentials must be members of it.
    // Never-registered members read as not wakeable (null stamp).
    if (auth.roomId && auth.roomId !== roomId)
      ctx.reject(403, "room_mismatch", "A room access key can only read its bound room");
    if (!auth.roomId && !isRoomMember(ctx.store, roomId, auth.identityId))
      ctx.reject(403, "room_membership_required", "Join the room to read its wake status");
    const list = ctx.store.agentHeartbeats.wakeStatusList();
    const members = new Set(roomMemberIdentityIds(ctx.store, roomId));
    const wakeable = [], notWakeable = [];
    for (const entry of list.wakeable) if (members.has(entry.agentId)) wakeable.push(coarsen(true)(entry));
    for (const entry of list.notWakeable) if (members.has(entry.agentId)) notWakeable.push(coarsen(false)(entry));
    // Members who never registered a host never polled: not wakeable too.
    const seen = new Set([...wakeable, ...notWakeable].map(entry => entry.agentId));
    for (const identityId of members) {
      if (!seen.has(identityId)) notWakeable.push(Object.freeze({ agentId: identityId, wakeable: false }));
    }
    return ctx.json(ctx.res, 200, {
      roomId, windowMs: list.windowMs, asOf: list.asOf,
      wakeable: Object.freeze(wakeable), notWakeable: Object.freeze(notWakeable),
    });
  })();
}

const query = Object.freeze({ type: "object",
  properties: {
    roomId: { type: "string", description: "List member wakeability for this room (you must be a member); omit for your own status" },
  } });

export const WAKE_STATUS_ROUTES = Object.freeze([
  Object.freeze({ id: "wake-status", method: "GET", path: "/api/wake-status",
    auth: "bearer", capability: null, scope: "directory", handler: readWakeStatus, authenticate: authenticateWakeStatus,
    schema: { query, response: { type: "object" } },
    events: [] }),
]);
