// RT handlers for authenticated permission requests and their existing queue.
// The RT owner registers these rows and supplies the shared accessRequests
// instance in dispatch context. Keeping that instance preserves one quota
// across the legacy request endpoint and both authenticated aliases.

function service(ctx) {
  if (!ctx.accessRequests) ctx.reject(500, "misconfigured", "Access-request service is not wired");
  return ctx.accessRequests;
}

function requireRoomScope(ctx, auth, write) {
  if (auth.kind !== "api-key") return;
  const required = write ? "rooms:write" : "rooms:read";
  if (!(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", `API key lacks ${required}`);
  }
}

function roomContext(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  ctx.rate(`read:${auth.credentialHash}`, 600);
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  }
  requireRoomScope(ctx, auth, write);
  return { roomId, selected, fence, auth };
}

export async function requestMemberPermissions(ctx) {
  const requests = service(ctx);
  const { roomId, selected, fence, auth } = roomContext(ctx, true);
  const data = await ctx.body(ctx.req);
  const field = ctx.route.path.endsWith("/members/me/permission-requests") ? "permissions" : "requestedPermissions";
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, field)
      || Object.keys(data).some(key => ![field, "note", "requestId"].includes(key))) {
    ctx.reject(422, "invalid_request", `${field} is required; note and requestId are optional`);
  }
  // Body reading may outlive a session or key change. Re-authenticate and
  // recheck scope before constructing a request for the authenticated member.
  const current = ctx.roomAuth(selected, roomId, fence);
  if (current.member.id !== auth.member.id) ctx.reject(403, "access_denied", "The acting member changed");
  requireRoomScope(ctx, current, true);
  const requested = requests.requestForMember(selected.token, roomId,
    { permissions: data[field], note: data.note, requestId: data.requestId }, fence);
  return ctx.json(ctx.res, 201, requested);
}

export async function listMemberAccessRequests(ctx) {
  const requests = service(ctx);
  const { roomId, selected, fence } = roomContext(ctx, false);
  const records = requests.list(selected.token, roomId, { status: ctx.url.searchParams.get("status") ?? "pending" }, fence);
  const next = records.length ? [{ action: "decide-request", method: "POST",
    path: `/api/rooms/${encodeURIComponent(roomId)}/access-requests/${encodeURIComponent(records[0].requestId)}/decide`,
    description: `Decide ${records[0].displayName}'s request: send { decision: "approve", permissions: ${JSON.stringify(records[0].requestedPermissions)}, note: null }. Use "deny" to refuse. Send your current room credential.` }]
    : [{ action: "watch-requests", description: "No pending access requests." }];
  return ctx.json(ctx.res, 200, { roomId, requests: records, next });
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const requestBody = field => Object.freeze({ type: "object", required: [field], additionalProperties: false,
  properties: { [field]: { type: "array", items: { type: "string" } }, note: { type: "string", nullable: true }, requestId: { type: "string" } } });

// Register all three together: adding POST alone at the queue's known path
// would make the RT dispatcher intercept and refuse the existing GET.
export const MEMBER_PERMISSION_ROUTES = Object.freeze([
  Object.freeze({ id: "request-member-permissions", method: "POST", path: "/api/rooms/{roomId}/access-requests",
    auth: "room", capability: null, scope: "room", handler: requestMemberPermissions,
    schema: { params: parameters, body: requestBody("requestedPermissions"), response: { type: "object" } },
    events: ["access.requested"] }),
  Object.freeze({ id: "request-own-permissions", method: "POST", path: "/api/rooms/{roomId}/members/me/permission-requests",
    auth: "room", capability: null, scope: "room", handler: requestMemberPermissions,
    schema: { params: parameters, body: requestBody("permissions"), response: { type: "object" } },
    events: ["access.requested"] }),
  Object.freeze({ id: "list-member-access-requests", method: "GET", path: "/api/rooms/{roomId}/access-requests",
    auth: "room", capability: null, scope: "room", handler: listMemberAccessRequests,
    schema: { params: parameters, query: { type: "object", properties: { status: { type: "string" } } }, response: { type: "object" } },
    events: [] }),
]);
