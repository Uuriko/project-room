// Agent dispatch. GET is the capacity, queue, and metrics read. POST ticks,
// answers an assignment, claims the coordinator seat, or lets the owner override.
// The human page is the same GET with no controls.

import { isRoomArchived } from "../../src/events.js";
import { actOnDispatch, sliceView } from "../agent-dispatch.mjs";
import { DISPATCH_PAGE_CSP, renderDispatchHtml } from "../agent-dispatch-view.mjs";
import { ServiceError } from "../service-error.mjs";

function context(ctx, write) {
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
    let state = null;
    try { state = ctx.store.room?.(roomId)?.state ?? null; } catch { state = null; }
    if (isRoomArchived(state)) ctx.reject(409, "room_archived", "This room is archived");
  }
  if (auth.kind === "api-key") {
    const required = write ? "rooms:write" : "rooms:read";
    if (!(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", `API key lacks ${required}`);
    }
  }
  const ownerId = ctx.store.room?.(roomId)?.state?.room?.ownerId ?? null;
  return {
    roomId,
    actor: {
      memberId: auth.member.id,
      displayName: auth.member.displayName,
      kind: auth.member.kind,
      role: auth.member.id === ownerId ? "owner" : "member"
    }
  };
}

function run(ctx, roomId, actor, body) {
  try {
    return ctx.json(ctx.res, 200, actOnDispatch(ctx.store, roomId, actor, body));
  } catch (error) {
    if (error instanceof ServiceError) ctx.reject(error.status, error.code, error.message);
    throw error;
  }
}

function wantsHuman(ctx) {
  if (ctx.url.searchParams.get("view") === "human") return true;
  const accept = String(ctx.req.headers?.accept ?? ctx.req.headers?.Accept ?? "");
  return accept.includes("text/html") && !accept.includes("application/json");
}

export function readDispatch(ctx) {
  const { roomId } = context(ctx, false);
  const full = ctx.store.agentDispatch.view(roomId);
  if (wantsHuman(ctx)) {
    const html = renderDispatchHtml(full);
    ctx.res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Content-Security-Policy": DISPATCH_PAGE_CSP,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex"
    });
    ctx.res.end(ctx.req.method === "HEAD" ? undefined : html);
    return;
  }
  const name = ctx.url.searchParams.get("view") || "all";
  let body;
  try { body = sliceView(full, name); }
  catch (error) {
    if (error instanceof ServiceError) ctx.reject(error.status, error.code, error.message);
    throw error;
  }
  return ctx.json(ctx.res, 200, body);
}

export async function tickDispatch(ctx) {
  const { roomId, actor } = context(ctx, true);
  await ctx.body(ctx.req, { allowEmpty: true, fields: [], unknownCode: "invalid_dispatch" });
  return run(ctx, roomId, actor, { action: "tick" });
}

export async function respondDispatch(ctx) {
  const { roomId, actor } = context(ctx, true);
  const data = await ctx.body(ctx.req);
  return run(ctx, roomId, actor, { action: "respond", assignmentId: data.assignmentId, decision: data.decision });
}

export async function seatDispatch(ctx) {
  const { roomId, actor } = context(ctx, true);
  const data = await ctx.body(ctx.req);
  const action = data.action === "release" ? "release_seat" : data.action === "claim" ? "claim_seat" : data.action;
  return run(ctx, roomId, actor, { action });
}

export async function overrideDispatch(ctx) {
  const { roomId, actor } = context(ctx, true);
  const data = await ctx.body(ctx.req);
  return run(ctx, roomId, actor, data);
}

export async function fixPlanDispatch(ctx) {
  const { roomId, actor } = context(ctx, true);
  const data = await ctx.body(ctx.req);
  return run(ctx, roomId, actor, { ...data, action: "fix_plan" });
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const response = Object.freeze({ type: "object" });

export const AGENT_DISPATCH_ROUTES = Object.freeze([
  Object.freeze({ id: "read-dispatch", method: "GET", path: "/api/rooms/{roomId}/dispatch",
    auth: "room", capability: null, scope: "room", handler: readDispatch, parity: "mcp:room_dispatch_read",
    schema: { params: parameters, response }, events: [] }),
  Object.freeze({ id: "tick-dispatch", method: "POST", path: "/api/rooms/{roomId}/dispatch/tick",
    auth: "room", capability: null, scope: "room", handler: tickDispatch, parity: "mcp:room_dispatch_act",
    schema: { params: parameters, response }, events: [] }),
  Object.freeze({ id: "respond-dispatch", method: "POST", path: "/api/rooms/{roomId}/dispatch/respond",
    auth: "room", capability: null, scope: "room", handler: respondDispatch, parity: "mcp:room_dispatch_act",
    schema: { params: parameters, body: { type: "object", required: ["assignmentId", "decision"], additionalProperties: false, properties: { assignmentId: { type: "string" }, decision: { type: "string" } } }, response }, events: [] }),
  Object.freeze({ id: "seat-dispatch", method: "POST", path: "/api/rooms/{roomId}/dispatch/seat",
    auth: "room", capability: null, scope: "room", handler: seatDispatch, parity: "mcp:room_dispatch_act",
    schema: { params: parameters, body: { type: "object", required: ["action"], additionalProperties: false, properties: { action: { type: "string" } } }, response }, events: [] }),
  Object.freeze({ id: "override-dispatch", method: "POST", path: "/api/rooms/{roomId}/dispatch/override",
    auth: "room", capability: null, scope: "room", handler: overrideDispatch, parity: "mcp:room_dispatch_act",
    schema: { params: parameters, body: { type: "object", required: ["action"], additionalProperties: false, properties: { action: { type: "string" }, memberId: { type: "string" }, taskKey: { type: "string" }, note: { type: "string" } } }, response }, events: [] }),
  Object.freeze({ id: "fix-plan-dispatch", method: "POST", path: "/api/rooms/{roomId}/dispatch/fix-plans",
    auth: "room", capability: null, scope: "room", handler: fixPlanDispatch, parity: "mcp:room_dispatch_act",
    schema: { params: parameters, body: { type: "object", required: ["id", "title", "files"], additionalProperties: false, properties: { id: { type: "string" }, title: { type: "string" }, files: { type: "array" }, value: { type: "number" }, blockedBy: { type: "array" } } }, response }, events: [] }),
]);
