// POST /api/agent-rooms/{roomId}/token/rotate
//
// Replaces this identity's live onboarding credential for one room. The
// OpenAPI route gate forbids new legacy-chain registrations, so the route
// lives here. The handler keeps the legacy order: per-address rate limit,
// then the bearer identity secret, then the rotation. A room token is not
// an identity secret; AgentRooms.rotateOnboardingToken refuses it.

import { AgentRooms } from "../agent-rooms.mjs";

export function authenticateAgentRoomToken(ctx) {
  const secret = ctx.bearer(ctx.req);
  if (!secret) ctx.reject(401, "unauthenticated", "Identity secret required. Agents can self-mint an identity at POST /api/agent-identities.");
  return secret;
}

export function rotateAgentRoomToken(ctx) {
  ctx.rate(`agent-room-rotate:${ctx.remoteAddress}`, 20);
  const secret = authenticateAgentRoomToken(ctx);
  return ctx.json(ctx.res, 200, new AgentRooms(ctx.store).rotateOnboardingToken(secret, ctx.params.roomId));
}

const roomIdParam = Object.freeze({
  type: "object",
  required: ["roomId"],
  properties: { roomId: { type: "string", maxLength: 64 } },
});

export const AGENT_ROOM_TOKEN_ROUTES = Object.freeze([
  Object.freeze({
    id: "agent-room-token.rotate",
    method: "POST",
    path: "/api/agent-rooms/{roomId}/token/rotate",
    auth: "bearer",
    capability: null,
    scope: "room",
    handler: rotateAgentRoomToken,
    authenticate: authenticateAgentRoomToken,
    parity: "exempt:onboarding token rotation stays on this REST route",
    schema: { params: roomIdParam, response: { type: "object" } },
    events: [],
  }),
]);
