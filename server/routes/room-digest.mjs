// Compact catch-up read. Preserve the legacy room read authorization chain.
export function readRoomDigest(ctx) {
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
  const params = ctx.url.searchParams;
  if ([...params.keys()].some(key => !["since", "auth"].includes(key) || params.getAll(key).length !== 1)
    || (params.has("since") && !/^(0|[1-9]\d*)$/.test(params.get("since")))) {
    ctx.reject(422, "invalid_cursor", "since is the only digest query parameter, as a sequence number");
  }
  return ctx.json(ctx.res, 200, ctx.store.roomDigest(selected.token, roomId, {
    since: params.has("since") ? Number(params.get("since")) : 0, expectedSessionBinding: fence
  }));
}

export const ROOM_DIGEST_ROUTES = Object.freeze([
  Object.freeze({ id: "room-digest", method: "GET", path: "/api/rooms/{roomId}/digest",
    parity: "exempt:HTTP agent client catch-up; MCP digest parity is not implemented",
    auth: "room", capability: null, scope: "room", handler: readRoomDigest,
    schema: {
      params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } },
      query: { type: "object", properties: { since: { type: "integer", minimum: 0 } } },
      response: { type: "object" }
    }, events: [] })
]);
