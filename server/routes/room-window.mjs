// Windowed room open and older-message page. Same authorization chain as
// the legacy room read: room credential, session fence, bearer room scope,
// read rate, rooms:read for API keys.
import { validId } from "../../src/events.js";
import { buildRoomBootstrap } from "../room-bootstrap.mjs";
import { readMessagePage, SNAPSHOT_WINDOW_MESSAGES } from "../snapshot-window.mjs";

function authorizeRoomRead(ctx) {
  const roomId = ctx.params.roomId;
  if (!validId(roomId)) ctx.reject(404, "not_found", "Not found");
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key") {
    const requiredScope = "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === requiredScope || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${requiredScope} scope`);
  }
  return { selected, fence, roomId };
}

function singleQuery(params, allowed) {
  return [...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1);
}

export function readRoomBootstrap(ctx) {
  const { selected, fence, roomId } = authorizeRoomRead(ctx);
  if (singleQuery(ctx.url.searchParams, ["auth"])) ctx.reject(422, "invalid_snapshot_view", "This read takes no query filters");
  const watchers = [...(ctx.streams ?? [])].filter(entry => entry.roomId === roomId).map(entry => entry.memberId);
  return ctx.json(ctx.res, 200, buildRoomBootstrap(ctx.store, selected.token, roomId, fence, {
    accessRequests: ctx.accessRequests, watchers
  }));
}

export function readRoomMessages(ctx) {
  const { selected, fence, roomId } = authorizeRoomRead(ctx);
  const params = ctx.url.searchParams;
  if (singleQuery(params, ["before", "beforeId", "limit", "auth"])
    || params.has("beforeId") && (!params.has("before") || !params.get("beforeId") || params.get("beforeId").length > 256)
    || params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit"))
    || params.has("before") && !/^(0|[1-9]\d*)$/.test(params.get("before"))) {
    ctx.reject(422, "invalid_snapshot_view", "Choose a message page");
  }
  return ctx.json(ctx.res, 200, readMessagePage(ctx.store, selected.token, roomId, {
    beforeId: params.get("beforeId"),
    before: params.has("before") ? Number(params.get("before")) : null,
    limit: params.has("limit") ? Number(params.get("limit")) : SNAPSHOT_WINDOW_MESSAGES,
    expectedSessionBinding: fence
  }));
}

const roomIdParam = { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } };

export const ROOM_WINDOW_ROUTES = Object.freeze([
  Object.freeze({
    id: "room-bootstrap", method: "GET", path: "/api/rooms/{roomId}/bootstrap",
    parity: "mcp:room_read_bootstrap",
    auth: "room", capability: null, scope: "room", handler: readRoomBootstrap,
    schema: { params: roomIdParam, response: { type: "object" } }, events: []
  }),
  Object.freeze({
    id: "room-messages", method: "GET", path: "/api/rooms/{roomId}/messages",
    parity: "exempt:paged older history behind the shared room window",
    auth: "room", capability: null, scope: "room", handler: readRoomMessages,
    schema: {
      params: roomIdParam,
      query: { type: "object", properties: {
        before: { type: "integer", minimum: 0 },
        beforeId: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      } },
      response: { type: "object" }
    }, events: []
  })
]);
