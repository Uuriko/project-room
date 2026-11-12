import { readProjectState } from "../project-state.mjs";
// Compact project state read. Same authorization chain as the room digest.
export function readRoomProjectState(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:read" || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", "API key lacks the rooms:read scope");
  }
  if ([...ctx.url.searchParams.keys()].some(key => key !== "auth")) ctx.reject(422, "invalid_query", "This read takes no query parameters");
  return ctx.json(ctx.res, 200, readProjectState(ctx.store, selected.token, roomId, { expectedSessionBinding: fence }));
}

export const ROOM_STATE_ROUTES = Object.freeze([
  Object.freeze({ id: "room-project-state", method: "GET", path: "/api/rooms/{roomId}/state",
    parity: "mcp:room_project_state",
    auth: "room", capability: null, scope: "room", handler: readRoomProjectState,
    schema: {
      params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } },
      query: { type: "object", properties: {} },
      response: { type: "object" }
    }, events: [] })
]);
