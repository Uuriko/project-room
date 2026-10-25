// plan-wake-live: GET /api/wake-status — who is actually listening.
//
// Wakeable = the agent polled (GET /api/agent-wakes/poll) or heartbeated
// within its wakeability window (24h, widened for a slower declared poll
// cadence — wakeableWindowFor in agent-heartbeats.mjs, issue #3592).
// Two modes, both scoped (Instinct-3 review, PR #1565):
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

import { HeartbeatError } from "../agent-heartbeats.mjs";
import { createHeartbeatActor, translateWith, requiredScope } from "../agent-plugin-routes.mjs";
import { identityIdsForWakeRoom, isWakeRoomMember } from "../wake-identity-resolution.mjs";

const coarsen = wakeable => entry => Object.freeze({ agentId: entry.agentId, wakeable });

// Room membership is guest-aware (#3908 F-8): trial seats are seated
// through guest_members and never receive an identity_links row, so both
// helpers resolve through the shared wake resolver - a guest caller is
// a member of its own room and guest seats appear in the room's lists.
// Both helpers take the request's single store-clock capture: the
// resolver gates its guest leg on the shared live-seat predicate, and
// one `now` per request keeps the gate and the roster consistent — a
// seat expiring mid-request is wholly in or wholly out of the answer.
function roomMemberIdentityIds(store, roomId, now) {
  return identityIdsForWakeRoom(store.db, roomId, now);
}

function isRoomMember(store, roomId, identityId, now) {
  return isWakeRoomMember(store.db, roomId, identityId, now);
}

export function authenticateWakeStatus(ctx) {
  const heartbeatActor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  return heartbeatActor(ctx.req, requiredScope("heartbeats:read"));
}

// Shared by GET /api/wake-status and the wake_status MCP tool. roomId null
// is the caller's own status. Throws HeartbeatError on a room refusal so
// both doors translate the same codes.
export function wakeStatusDocument(store, auth, roomId) {
  if (roomId === null || roomId === undefined) {
    const status = store.agentHeartbeats.wakeStatusOf(auth.identityId);
    return { agentId: status.agentId, wakeable: status.wakeable, windowMs: status.windowMs };
  }
  const now = store.now();
  if (auth.roomId && auth.roomId !== roomId)
    throw new HeartbeatError(403, "room_mismatch", "A room access key can only read its bound room");
  if (!auth.roomId && !isRoomMember(store, roomId, auth.identityId, now))
    throw new HeartbeatError(403, "room_membership_required", "Join the room to read its wake status");
  const list = store.agentHeartbeats.wakeStatusListForRoom(roomId);
  const members = new Set(roomMemberIdentityIds(store, roomId, now));
  const wakeable = [], notWakeable = [];
  for (const entry of list.wakeable) if (members.has(entry.agentId)) wakeable.push(coarsen(true)(entry));
  for (const entry of list.notWakeable) if (members.has(entry.agentId)) notWakeable.push(coarsen(false)(entry));
  const seen = new Set([...wakeable, ...notWakeable].map(entry => entry.agentId));
  for (const identityId of members) {
    if (!seen.has(identityId)) notWakeable.push(Object.freeze({ agentId: identityId, wakeable: false }));
  }
  return {
    roomId, windowMs: list.windowMs, asOf: list.asOf,
    wakeable: Object.freeze(wakeable), notWakeable: Object.freeze(notWakeable),
  };
}

export async function readWakeStatus(ctx) {
  const auth = authenticateWakeStatus(ctx);
  ctx.rate(`wake-status-read:${auth.identityId}`, 120);
  return translateWith(ctx.reject)(async () => {
    const roomId = ctx.url.searchParams.get("roomId");
    return ctx.json(ctx.res, 200, wakeStatusDocument(ctx.store, auth, roomId));
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
