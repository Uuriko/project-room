import { reportMacCapability } from "../mac-capabilities.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";
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
  const params = ctx.url.searchParams;
  if ([...params.keys()].some(key => !["auth", "receiverMemberId", "receiverWorkItemId"].includes(key) || params.getAll(key).length !== 1))
    ctx.reject(422, "invalid_query", "Choose a receiver member and optional work item");
  return ctx.json(ctx.res, 200, readProjectState(ctx.store, selected.token, roomId, {
    expectedSessionBinding: fence, streams: ctx.streams,
    receiverMemberId: params.get("receiverMemberId") ?? undefined,
    receiverWorkItemId: params.get("receiverWorkItemId") ?? undefined
  }));
}

async function postMacCapability(ctx) {
  const { req, res, store } = ctx;
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(req, ctx.url), fence = ctx.expectedBinding(req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!selected.bearer || auth.credentialScope !== "room" || auth.member.kind !== "agent" || isGuestAgentMemberId(auth.member.id))
    ctx.reject(403, "access_denied", "An authenticated Room agent must report its own Mac capability");
  ctx.protectWrite(req, auth, true);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*"))
    ctx.reject(403, "insufficient_scope", "API key lacks the rooms:write scope");
  const input = await ctx.body(req);
  const current = ctx.roomAuth(selected, roomId, fence);
  if (current.member.id !== auth.member.id || current.member.kind !== "agent" || current.member.active !== true)
    ctx.reject(403, "access_denied", "Mac receiver membership changed");
  const report = reportMacCapability(store, roomId, current.member.id, input);
  if (report.error) ctx.reject(report.status, report.error, "Mac capability report refused");
  return ctx.json(res, 200, report);
}

export const ROOM_STATE_ROUTES = Object.freeze([
  Object.freeze({ id: "room-project-state", method: "GET", path: "/api/rooms/{roomId}/state",
    parity: "mcp:room_project_state",
    auth: "room", capability: null, scope: "room", handler: readRoomProjectState,
    schema: {
      params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } },
      query: { type: "object", properties: { receiverMemberId: { type: "string" }, receiverWorkItemId: { type: "string" } } },
      response: { type: "object" }
    }, events: [] }),
  Object.freeze({ id: "mac-capability-report", method: "POST", path: "/api/rooms/{roomId}/mac-capability",
    auth: "room", capability: null, scope: "room", handler: postMacCapability,
    parity: "exempt:app-owned receiver reports its own short-lived local readiness",
    description: "Reports a Mac receiver session for the authenticated agent. Ready requires the approved work item, baseline, head and sender set. Stop withdraws readiness.",
    schema: {
      params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } },
      body: { type: "object", required: ["sessionId", "state"], additionalProperties: false, properties: {
        sessionId: { type: "string", format: "uuid" },
        state: { type: "string", enum: ["ready", "unavailable", "stopped"] },
        workItemId: { type: "string" }, head: { type: "string" }, base: { type: "string" },
        requesters: { type: "array", items: { type: "string" } },
        checks: { type: "array", items: { type: "string", enum: ["affected", "build", "native-smoke", "draft-recovery"] } }
      } },
      response: { type: "object", properties: { state: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } }
    }, events: [] })
]);
