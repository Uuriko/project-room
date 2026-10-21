// Shared memory and owner-taught rules over REST; MCP tools call the same functions.
//
// GET    /api/rooms/{roomId}/memory?q=&limit=       search the caller's own owner's memory (top 5 above a floor)
// POST   /api/rooms/{roomId}/memory                 { requestId, text, kind?: note|rule, source?, importance?, topic?, replaces?, scope?, trigger?, agentId?, allAgents?, confirm?, hard? }
// DELETE /api/rooms/{roomId}/memory/{memoryId}      invalidate a note (history kept)
// GET    /api/rooms/{roomId}/memory/rules?view=active|list&tool=&path=
// POST   /api/rooms/{roomId}/memory/rules           { usedIds?, harmfulIds? } or, owner only, { confirmIds?, keepIds?, pruneIds?, undoIds?, replaceId? }
import { isRoomArchived } from "../../src/events.js";
import { forgetMemory, listRules, manageRules, ownerOf, proposeRule, recordRuleUse, rulesForTurn, searchMemory, writeNote } from "../agent-memory.mjs";

function access(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (write) {
    let state = null;
    try { state = ctx.store.room?.(roomId)?.state ?? null; } catch { state = null; }
    if (isRoomArchived(state)) ctx.reject(409, "room_archived", "This room is archived");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(s => s === "rooms:write" || s === "rooms:*")) ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    ctx.rate(`write:${auth.credentialHash}`, 60);
  } else ctx.rate(`read:${auth.credentialHash}`, 600);
  return { roomId, auth };
}

export function readMemory(ctx) {
  const { roomId, auth } = access(ctx, false);
  const limit = ctx.url.searchParams.get("limit");
  return ctx.json(ctx.res, 200, { roomId, ...searchMemory(ctx.store, auth, roomId, { query: ctx.url.searchParams.get("q"), limit: limit ? Number(limit) : undefined }) });
}
export async function postMemory(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  const result = data?.kind === "rule" ? proposeRule(ctx.store, auth, roomId, data) : writeNote(ctx.store, auth, roomId, data);
  const status = result.action === "cap_reached" || result.action === "conflict" ? 409 : result.action === "noop" ? 200 : 201;
  return ctx.json(ctx.res, status, { roomId, ...result });
}
export function deleteMemory(ctx) {
  const { roomId, auth } = access(ctx, true);
  return ctx.json(ctx.res, 200, { roomId, ...forgetMemory(ctx.store, auth, roomId, ctx.params.memoryId) });
}
export function readRules(ctx) {
  const { roomId, auth } = access(ctx, false);
  ownerOf(ctx.store, auth, roomId);
  if (ctx.url.searchParams.get("view") === "list") return ctx.json(ctx.res, 200, { roomId, ...listRules(ctx.store, auth, roomId) });
  return ctx.json(ctx.res, 200, { roomId, ...rulesForTurn(ctx.store, auth, roomId, { tool: ctx.url.searchParams.get("tool"), paths: ctx.url.searchParams.getAll("path") }) });
}
export async function postRules(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req) ?? {};
  if (data.usedIds || data.harmfulIds) recordRuleUse(ctx.store, auth, roomId, data);
  if (!data.confirmIds && !data.keepIds && !data.pruneIds && !data.undoIds) return ctx.json(ctx.res, 200, { roomId, recorded: true });
  return ctx.json(ctx.res, 200, { roomId, ...manageRules(ctx.store, auth, roomId, data) });
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const idParams = Object.freeze({ type: "object", required: ["roomId", "memoryId"], properties: { roomId: { type: "string" }, memoryId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const row = (id, method, path, handler, p, parity) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const AGENT_MEMORY_ROUTES = Object.freeze([
  row("agent-memory-search", "GET", "/api/rooms/{roomId}/memory", readMemory, params, "mcp:room_memory_search"),
  row("agent-memory-write", "POST", "/api/rooms/{roomId}/memory", postMemory, params, "mcp:room_memory_write"),
  row("agent-memory-rules-read", "GET", "/api/rooms/{roomId}/memory/rules", readRules, params, "mcp:room_rules"),
  row("agent-memory-rules-write", "POST", "/api/rooms/{roomId}/memory/rules", postRules, params, "mcp:room_rules"),
  row("agent-memory-forget", "DELETE", "/api/rooms/{roomId}/memory/{memoryId}", deleteMemory, idParams, "mcp:room_memory_forget"),
]);
