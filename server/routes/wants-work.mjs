// BOARD-WAKE-2: an agent member's own "new ready work" preference
// (server/work-wants.mjs). GET reads it, PUT sets { labels?, capabilities? },
// DELETE turns it off. Only agent members may set it; it is always the
// caller's own row. Default off.

import { isRoomArchived } from "../../src/events.js";
import { WantsWorkInputError, clearWantsWork, readWantsWork, setWantsWork } from "../work-wants.mjs";

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
  }
  if (auth.kind === "api-key") {
    const required = write ? "rooms:write" : "rooms:read";
    if (!(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", `API key lacks ${required}`);
    }
  }
  return { roomId, auth };
}

function refuseNonAgent(ctx, auth) {
  if (auth.member?.kind !== "agent") ctx.reject(403, "agent_only", "Only agent members can ask to be woken for new ready work");
}

function refuseArchived(ctx, roomId) {
  let state = null;
  try { state = ctx.store.room?.(roomId)?.state ?? null; } catch { state = null; }
  if (isRoomArchived(state)) ctx.reject(409, "room_archived", "This room is archived");
}

const body = (roomId, memberId, value) => ({ roomId, memberId, ...value });

export function readOwnWantsWork(ctx) {
  const { roomId, auth } = context(ctx, false);
  return ctx.json(ctx.res, 200, body(roomId, auth.member.id, readWantsWork(ctx.store.db, roomId, auth.member.id)));
}

export async function putOwnWantsWork(ctx) {
  const { roomId, auth } = context(ctx, true);
  refuseNonAgent(ctx, auth);
  refuseArchived(ctx, roomId);
  const data = await ctx.body(ctx.req);
  const now = typeof ctx.store.now === "function" ? ctx.store.now() : Date.now();
  try {
    return ctx.json(ctx.res, 200, body(roomId, auth.member.id, setWantsWork(ctx.store.db, roomId, auth.member.id, data, now)));
  } catch (error) {
    if (error instanceof WantsWorkInputError) ctx.reject(422, "invalid_request", error.message);
    throw error;
  }
}

export function deleteOwnWantsWork(ctx) {
  const { roomId, auth } = context(ctx, true);
  return ctx.json(ctx.res, 200, body(roomId, auth.member.id, clearWantsWork(ctx.store.db, roomId, auth.member.id)));
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const list = Object.freeze({ type: "array", items: { type: "string" } });
const PATH = "/api/rooms/{roomId}/members/me/wants-work";
const RESPONSE = Object.freeze({ type: "object" });

export const WANTS_WORK_ROUTES = Object.freeze([
  ["read-own-wants-work", "GET", readOwnWantsWork, { params: parameters, response: RESPONSE }],
  ["set-own-wants-work", "PUT", putOwnWantsWork, { params: parameters,
    body: { type: "object", additionalProperties: false, properties: { labels: list, capabilities: list } },
    response: RESPONSE }],
  ["clear-own-wants-work", "DELETE", deleteOwnWantsWork, { params: parameters, response: RESPONSE }],
].map(([id, method, handler, schema]) => Object.freeze({
  id, method, path: PATH, auth: "room", capability: null, scope: "room", handler, schema, events: [] })));
