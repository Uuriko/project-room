// Design upgrade routes. The flag read is always available so a client can
// skip the UI. Status, inbox, ack, and result require the flag and answer
// with the same bodies the room MCP tools return.
import { ownMember } from "../../src/events.js";
import { ServiceError } from "../service-error.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";
import {
  readFlag, writeFlag, collectNeedsYou, readTaskStatus, readAck, acknowledge, readResult, putResult,
} from "../design-upgrade.mjs";

function fail(ctx, error) {
  if (!(error instanceof ServiceError) && !(error && Number.isInteger(error.status) && typeof error.code === "string")) throw error;
  return ctx.json(ctx.res, error.status, {
    error: { code: error.code, message: error.message },
    ...(error.next ? { next: error.next } : {}),
  });
}

function authenticate(ctx, writing = false) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Room membership required");
  const required = writing ? "rooms:write" : "rooms:read";
  if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
    ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
  }
  ctx.rate(`${writing ? "write" : "read"}:${auth.credentialHash}`, writing ? 60 : 600);
  if (writing) {
    if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, "guest_scope_denied", "Guest members cannot perform this action");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
  }
  const authority = typeof ctx.store.roomAuthority === "function" ? ctx.store.roomAuthority(roomId) : ctx.store.room(roomId).state;
  const member = ownMember(authority?.members, auth.member.id) ?? auth.member;
  if (!member || member.active === false) ctx.reject(403, "not_member", "Not a member of this room");
  return { roomId, auth, member, secret: selected.token };
}

async function run(ctx, writing, fn) {
  try {
    const { roomId, auth, member, secret } = authenticate(ctx, writing);
    return await fn({ roomId, auth, member, secret });
  } catch (error) {
    return fail(ctx, error);
  }
}

export function getDesignUpgrade(ctx) {
  return run(ctx, false, ({ roomId }) => ctx.json(ctx.res, 200, readFlag(ctx.store, roomId)));
}

export async function postDesignUpgrade(ctx) {
  return run(ctx, true, async ({ roomId, member }) => {
    const data = await ctx.body(ctx.req);
    return ctx.json(ctx.res, 200, writeFlag(ctx.store, member, roomId, data.enabled));
  });
}

export function getNeedsYou(ctx) {
  return run(ctx, false, ({ roomId, member }) => {
    const cursor = ctx.url.searchParams.get("cursor");
    const limit = ctx.url.searchParams.get("limit");
    return ctx.json(ctx.res, 200, collectNeedsYou(ctx.store, member, roomId, {
      cursor, limit, now: typeof ctx.store.now === "function" ? ctx.store.now() : Date.now(),
    }));
  });
}

export function getTaskStatus(ctx) {
  return run(ctx, false, ({ roomId, member }) => ctx.json(ctx.res, 200, readTaskStatus(ctx.store, member, roomId, {
    kind: ctx.url.searchParams.get("kind"),
    id: ctx.url.searchParams.get("id"),
    ids: ctx.url.searchParams.get("ids"),
  })));
}

export function getTaskAck(ctx) {
  return run(ctx, false, ({ roomId, member }) => ctx.json(ctx.res, 200, readAck(
    ctx.store, member, roomId, ctx.url.searchParams.get("kind"), ctx.url.searchParams.get("id"))));
}

export async function postTaskAck(ctx) {
  return run(ctx, true, async ({ roomId, member, secret }) => {
    const data = await ctx.body(ctx.req);
    return ctx.json(ctx.res, 200, acknowledge(ctx.store, secret, member, roomId, data.kind, data.id));
  });
}

export function getTaskResult(ctx) {
  return run(ctx, false, ({ roomId, member }) => ctx.json(ctx.res, 200, readResult(
    ctx.store, member, roomId, ctx.url.searchParams.get("kind"), ctx.url.searchParams.get("id"))));
}

export async function postTaskResult(ctx) {
  return run(ctx, true, async ({ roomId, member }) => {
    const data = await ctx.body(ctx.req);
    return ctx.json(ctx.res, 200, putResult(ctx.store, member, roomId, data.kind, data.id, data));
  });
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const response = Object.freeze({ type: "object" });

export const DESIGN_UPGRADE_ROUTES = Object.freeze([
  Object.freeze({ id: "design-upgrade-read", method: "GET", path: "/api/rooms/{roomId}/design-upgrade",
    auth: "room", capability: null, scope: "room", handler: getDesignUpgrade,
    schema: { params: parameters, response }, events: [],
    parity: "exempt:owner flag read has no MCP twin" }),
  Object.freeze({ id: "design-upgrade-write", method: "POST", path: "/api/rooms/{roomId}/design-upgrade",
    auth: "room", capability: null, scope: "room", handler: postDesignUpgrade,
    schema: { params: parameters, response }, events: [],
    parity: "exempt:owner flag write has no MCP twin" }),
  Object.freeze({ id: "needs-you-read", method: "GET", path: "/api/rooms/{roomId}/needs-you",
    auth: "room", capability: null, scope: "room", handler: getNeedsYou,
    schema: { params: parameters, response }, events: [],
    parity: "mcp:room_needs_you" }),
  Object.freeze({ id: "task-status-read", method: "GET", path: "/api/rooms/{roomId}/task-status",
    auth: "room", capability: null, scope: "room", handler: getTaskStatus,
    schema: { params: parameters, response }, events: [],
    parity: "mcp:room_task_status" }),
  Object.freeze({ id: "task-ack-read", method: "GET", path: "/api/rooms/{roomId}/acks",
    auth: "room", capability: null, scope: "room", handler: getTaskAck,
    schema: { params: parameters, response }, events: [],
    parity: "exempt:ack field is on room_task_status and room_needs_you" }),
  Object.freeze({ id: "task-ack-write", method: "POST", path: "/api/rooms/{roomId}/acks",
    auth: "room", capability: null, scope: "room", handler: postTaskAck,
    schema: { params: parameters, response }, events: [],
    parity: "mcp:room_ack_task" }),
  Object.freeze({ id: "task-result-read", method: "GET", path: "/api/rooms/{roomId}/task-result",
    auth: "room", capability: null, scope: "room", handler: getTaskResult,
    schema: { params: parameters, response }, events: [],
    parity: "mcp:room_read_task_result" }),
  Object.freeze({ id: "task-result-write", method: "POST", path: "/api/rooms/{roomId}/task-result",
    auth: "room", capability: null, scope: "room", handler: postTaskResult,
    schema: { params: parameters, response }, events: [],
    parity: "mcp:room_put_task_result" }),
]);
