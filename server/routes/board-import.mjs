// Board import. OFF unless ROOM_BOARD_IMPORT=1. Room owner only.
// POST /api/rooms/{roomId}/board-import {source, items, dryRun?}
// See server/board-import.mjs.
import { boardImportEnabled, importBoardTasks, IMPORT_SOURCES, MAX_IMPORT } from "../board-import.mjs";

export async function postBoardImport(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const checkAuth = auth => {
    if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
    if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => scope === "rooms:write" || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    }
  };
  let auth = ctx.roomAuth(selected, roomId, fence);
  checkAuth(auth);
  ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 10);
  if (!boardImportEnabled()) ctx.reject(404, "not_found", "Not found");
  const data = await ctx.body(ctx.req, { fields: ["source", "items", "dryRun"], unknownCode: "invalid_body" });
  const current = ctx.roomAuth(selected, roomId, fence);
  checkAuth(current);
  if (current.member.id !== auth.member.id) ctx.reject(403, "access_denied", "The acting member changed");
  ctx.protectWrite(ctx.req, current, selected.bearer);
  auth = current;
  if (ctx.store.roomAuthority(roomId).ownerId !== auth.member.id) ctx.reject(403, "access_denied", "Only the room owner can import tasks");
  if (!data || typeof data !== "object" || !IMPORT_SOURCES.includes(data.source)) ctx.reject(422, "invalid_body", `source must be one of ${IMPORT_SOURCES.join(", ")}`);
  if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > MAX_IMPORT) ctx.reject(422, "invalid_body", `items must be an array of 1..${MAX_IMPORT} exported items`);
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") ctx.reject(422, "invalid_body", "dryRun must be a boolean");
  const out = importBoardTasks(ctx.store, roomId, auth.member.id, { source: data.source, items: data.items, dryRun: data.dryRun === true });
  return ctx.json(ctx.res, out.created > 0 ? 201 : 200, { ok: true, roomId, ...out });
}

export const BOARD_IMPORT_ROUTES = Object.freeze([
  Object.freeze({ id: "board-import", method: "POST", path: "/api/rooms/{roomId}/board-import",
    auth: "room", capability: null, scope: "room", handler: postBoardImport,
    parity: "exempt:owner-only bulk migration from another tracker; agents open tasks one at a time with the existing work tools",
    schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }, body: { type: "object" }, response: { type: "object" } },
    events: ["work_claim.updated"] }),
]);
