// Scoped projection read. Same authorization chain as the other room
// reads (room-window / room-digest): room credential, session fence,
// bearer <redacted> scope, read rate, rooms:read for API keys. The only new
// surface is the `fields` slice cut by server/room-projection.mjs from the
// shared windowed snapshot — no new visibility path.
import { parseProjectionFields, readRoomProjection } from "../room-projection.mjs";

export function getRoomProjection(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer <redacted> sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key") {
    const requiredScope = "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
  }
  const params = ctx.url.searchParams;
  const fields = params.getAll("fields").length === 1 ? parseProjectionFields(params.get("fields")) : null;
  if ([...params.keys()].some(key => !["fields", "auth"].includes(key)) || fields === null) {
    ctx.reject(422, "invalid_snapshot_view", "Choose projection fields from: summary, room, members, channels, messages, work, audit, pins, bonds");
  }
  return ctx.json(ctx.res, 200, readRoomProjection(ctx.store, selected.token, roomId, fence, fields));
}

const roomIdParam = { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } };

export const ROOM_PROJECTION_ROUTES = Object.freeze([
  Object.freeze({
    id: "room-projection", method: "GET", path: "/api/rooms/{roomId}/projection",
    parity: "exempt:scoped HTTP projection read; MCP parity is a follow-up packet filed by RR-D2",
    auth: "room", capability: null, scope: "room", handler: getRoomProjection,
    schema: {
      params: roomIdParam,
      query: { type: "object", properties: { fields: { type: "string" } } },
      response: { type: "object" }
    }, events: []
  })
]);
