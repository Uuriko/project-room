function account(ctx, write) {
  const token = ctx.cookie(ctx.req, ctx.accountCookieName), binding = ctx.accountBinding(ctx.req);
  const auth = ctx.store.authenticateAccountSession(token, null, binding);
  if (write) { ctx.protectWrite(ctx.req, auth, false); ctx.rate(`human-join:${auth.account.id}`, 20); }
  return { token, binding };
}
function room(ctx, write) {
  const roomId = ctx.params.roomId, selected = ctx.roomCredentials(ctx.req, ctx.url);
  const binding = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, binding);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Room credential required");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (write) { ctx.protectWrite(ctx.req, auth, selected.bearer); ctx.rate(`write:${auth.credentialHash}`, 60); }
  return { token: selected.token, binding, roomId };
}
async function own(ctx) {
  const write = ctx.req.method === "POST", { token, binding } = account(ctx, write), service = ctx.store.accountJoinRequests;
  if (!write) return ctx.json(ctx.res, 200, service.listOwn(token, binding));
  const data = await ctx.body(ctx.req);
  if (ctx.params.requestId) {
    if (!ctx.exact(data, ["expectedRevision"])) ctx.reject(422, "invalid_join_request", "Current request revision required");
    return ctx.json(ctx.res, 200, service.cancel(token, binding, ctx.params.requestId, data.expectedRevision));
  }
  return ctx.json(ctx.res, 201, service.request(token, binding, data));
}
async function review(ctx) {
  const write = ctx.req.method === "POST", { token, binding, roomId } = room(ctx, write), service = ctx.store.accountJoinRequests;
  if (!write) return ctx.json(ctx.res, 200, service.list(token, roomId, binding, { after: ctx.url.searchParams.get("after") }));
  const data = await ctx.body(ctx.req);
  if (!ctx.exact(data, ["decision", "expectedRevision"])) ctx.reject(422, "invalid_join_decision", "Decision and current request revision required");
  return ctx.json(ctx.res, 200, service.decide(token, roomId, binding, ctx.params.requestId, data));
}
async function visibility(ctx) {
  const write = ctx.req.method === "POST", { token, binding, roomId } = room(ctx, write);
  const data = write ? await ctx.body(ctx.req) : null;
  return ctx.json(ctx.res, 200, ctx.store.accountJoinRequests.visibility(token, roomId, binding, data));
}
const object = { type: "object" };
const revision = { type: "integer", minimum: 0 };
const body = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const requestBody = { ...body({ roomId: { type: "string", maxLength: 64 }, requestId: { type: "string", pattern: "^humanjoin-[A-Za-z0-9_-]+$", maxLength: 64 }, displayName: { type: "string", minLength: 1, maxLength: 80 } }), properties: {
  roomId: { type: "string", maxLength: 64 }, requestId: { type: "string", pattern: "^humanjoin-[A-Za-z0-9_-]+$", maxLength: 64 }, displayName: { type: "string", minLength: 1, maxLength: 80 }, note: { type: "string", maxLength: 1000 }
} };
export const ACCOUNT_JOIN_REQUEST_ROUTES = Object.freeze([
  ...["GET", "POST"].map(method => ({ id: `room-join-settings-${method.toLowerCase()}`, method, path: "/api/rooms/{roomId}/join-settings", auth: "room", scope: "room", capability: "manage_members", handler: visibility, schema: { ...(method === "POST" ? { body: body({ discoverable: { type: "boolean" }, expectedDiscoverable: { type: "boolean" } }) } : {}), response: object }, events: [] })),
  { id: "human-join-request", method: "POST", path: "/api/account-join-requests", auth: "account", scope: "worker", capability: null, handler: own, schema: { body: requestBody, response: object }, events: ["access.requested"] },
  { id: "human-join-status", method: "GET", path: "/api/account-join-requests", auth: "account", scope: "worker", capability: null, handler: own, schema: { response: object }, events: [] },
  { id: "human-join-cancel", method: "POST", path: "/api/account-join-requests/{requestId}/cancel", auth: "account", scope: "worker", capability: null, handler: own, schema: { body: body({ expectedRevision: revision }), response: object }, events: [] },
  { id: "human-join-review", method: "GET", path: "/api/rooms/{roomId}/join-requests", auth: "room", scope: "room", capability: "manage_members", handler: review, schema: { response: object }, events: [] },
  { id: "human-join-decide", method: "POST", path: "/api/rooms/{roomId}/join-requests/{requestId}/decide", auth: "room", scope: "room", capability: "manage_members", handler: review, schema: { body: body({ decision: { type: "string", enum: ["approve", "deny"] }, expectedRevision: revision }), response: object }, events: ["member.added"] },
]);
