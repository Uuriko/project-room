// GET /api/rooms/{roomId}/agent-sessions. Any room member, including agents.
// ROOM_AGENT_SESSIONS off returns enabled:false and an empty list.

import { buildAgentSessions, sessionsEnabled } from "../agent-sessions.mjs";

function readContext(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:read" || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", "API key lacks rooms:read");
  }
  if (!auth.member || auth.member.active === false) ctx.reject(403, "access_denied", "Room membership required");
  return { roomId };
}

export function readAgentSessions(ctx) {
  const { roomId } = readContext(ctx);
  const params = ctx.url.searchParams;
  if ([...params.keys()].some(key => key !== "q" && key !== "auth") || params.getAll("q").length > 1) {
    ctx.reject(422, "invalid_search", "q is the only search parameter");
  }
  let query = null;
  if (params.has("q")) {
    query = params.get("q").trim();
    if (!query || query.length > 80) ctx.reject(422, "invalid_search", "Search is 1 to 80 characters");
  }
  if (!sessionsEnabled(ctx.store, roomId)) {
    return ctx.json(ctx.res, 200, { roomId, enabled: false, sessions: [], truncated: false });
  }
  return ctx.json(ctx.res, 200, buildAgentSessions(ctx.store, roomId, { query }));
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });

export const AGENT_SESSION_ROUTES = Object.freeze([
  Object.freeze({ id: "agent-sessions", method: "GET", path: "/api/rooms/{roomId}/agent-sessions",
    parity: "exempt:room session list for members and agents; no MCP twin",
    auth: "room", capability: null, scope: "room", handler: readAgentSessions,
    schema: { params: parameters, query: { type: "object", properties: { q: { type: "string" } } }, response: { type: "object" } },
    events: [] }),
]);
