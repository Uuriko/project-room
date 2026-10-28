// ask_owner (Board item reason-take-3, part B).
//
// POST /api/rooms/{roomId}/ask-owner opens one reply request from the calling
// agent to its accountable human and returns at once with the request id. It
// never holds the connection open waiting for an answer: the agent reads the
// outcome with GET ?requestMessageId=, needs-me, or a wake. One open question to
// the owner at a time; a retry with the same requestId returns the same request.
//
// The outcome is answered, declined, cancelled or unanswered. It is not approval
// to execute anything. answerCredential says which credential route the answer
// arrived on (account_session or room_credential), stamped by the server.

function access(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  const scopeNeeded = write ? "rooms:write" : "rooms:read";
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === scopeNeeded || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", `API key lacks ${scopeNeeded}`);
  }
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    ctx.rate(`write:${auth.credentialHash}`, 60);
  } else ctx.rate(`read:${auth.credentialHash}`, 600);
  return { roomId, token: selected.token };
}

export async function postAskOwner(ctx) {
  const { roomId, token } = access(ctx, true);
  const data = await ctx.body(ctx.req, { fields: ["question", "requestId"], unknownCode: "invalid_body" });
  const value = ctx.store.replyRequests.askOwner(token, roomId, { question: data.question, requestId: data.requestId });
  return ctx.json(ctx.res, value.duplicate ? 200 : 201, value);
}

export function getAskOwner(ctx) {
  const { roomId, token } = access(ctx, false);
  const params = ctx.url.searchParams;
  if ([...params.keys()].some(key => !["requestMessageId", "auth"].includes(key) || params.getAll(key).length !== 1) || !params.has("requestMessageId")) {
    ctx.reject(422, "invalid_reply_selection", "requestMessageId is the only query parameter");
  }
  return ctx.json(ctx.res, 200, ctx.store.replyRequests.askOwnerStatus(token, roomId, params.get("requestMessageId")));
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const parity = "exempt:HTTP first; the MCP twin follows once the open MCP catalog changes land (reason-take-3)";

export const ASK_OWNER_ROUTES = Object.freeze([
  Object.freeze({ id: "ask-owner", method: "POST", path: "/api/rooms/{roomId}/ask-owner", parity,
    auth: "room", capability: null, scope: "room", handler: postAskOwner,
    schema: { params, body: { type: "object", required: ["question", "requestId"],
      properties: { question: { type: "string" }, requestId: { type: "string" } } }, response: { type: "object" } },
    events: ["message.posted"] }),
  Object.freeze({ id: "ask-owner-status", method: "GET", path: "/api/rooms/{roomId}/ask-owner", parity,
    auth: "room", capability: null, scope: "room", handler: getAskOwner,
    schema: { params, query: { type: "object", required: ["requestMessageId"], properties: { requestMessageId: { type: "string" } } },
      response: { type: "object" } }, events: [] })
]);
