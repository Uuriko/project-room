// GET/POST /api/rooms/{roomId}/status-lines
// presence.status_set as a side-table upsert. Off unless ROOM_STATUS_LINES is
// "1" or "true". The handler enforces auth: dispatch does not run the
// pipeline when ctx.pipeline is unset.

import { statusLinesEnabled } from "../member-status-lines.mjs";

function disabled(ctx) {
  ctx.reject(404, "status_lines_disabled", "Status lines are off.");
}

function roomMember(ctx, roomId, { write }) {
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (write) ctx.protectWrite(ctx.req, auth, selected.bearer);
  const scope = write ? "rooms:write" : "rooms:read";
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(item => item === scope || item === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", write ? "API key lacks rooms:write" : "API key lacks the rooms:read scope");
  }
  ctx.rate(`${write ? "write" : "read"}:${auth.credentialHash}`, write ? 60 : 600);
  return auth;
}

export function readStatusLines(ctx) {
  if (!statusLinesEnabled()) disabled(ctx);
  const roomId = ctx.params.roomId;
  roomMember(ctx, roomId, { write: false });
  return ctx.json(ctx.res, 200, { lines: ctx.store.memberStatusLines.list(roomId) });
}

export async function setStatusLine(ctx) {
  if (!statusLinesEnabled()) disabled(ctx);
  const roomId = ctx.params.roomId;
  const auth = roomMember(ctx, roomId, { write: true });
  ctx.rate(`status:${auth.credentialHash}`, 30);
  const data = await ctx.body(ctx.req);
  if (!Object.hasOwn(data, "text") || Object.keys(data).some(key => key !== "text")) {
    ctx.reject(422, "invalid_status_line", "Status line takes text only.");
  }
  return ctx.json(ctx.res, 200, ctx.store.memberStatusLines.set(roomId, auth.member.id, data.text));
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });

export const STATUS_LINE_ROUTES = Object.freeze([
  Object.freeze({ id: "status-lines-read", method: "GET", path: "/api/rooms/{roomId}/status-lines",
    auth: "room", capability: null, scope: "room", handler: readStatusLines,
    parity: "exempt:header read of the same rows room_set_status writes; no separate read tool",
    schema: { params: parameters, response: { type: "object" } },
    events: [] }),
  Object.freeze({ id: "status-lines-set", method: "POST", path: "/api/rooms/{roomId}/status-lines",
    auth: "room", capability: null, scope: "room", handler: setStatusLine,
    parity: "mcp:room_set_status",
    schema: {
      params: parameters,
      body: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      response: { type: "object" }
    },
    events: [] }),
]);
