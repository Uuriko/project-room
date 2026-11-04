// Board saved views admin. OFF unless ROOM_BOARD_VIEWS=1.
// POST /api/rooms/{roomId}/board-views with exactly one of:
//   {list: true} | {create: {name, query}} | {delete: viewId}
// See server/board-views.mjs.
import { boardViewsEnabled, viewQueryOf, createView, getView, listViews, deleteView, VIEW_QUERY_KEYS } from "../board-views.mjs";

export async function postBoardViews(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  if (!boardViewsEnabled()) ctx.reject(404, "not_found", "Not found");
  const data = await ctx.body(ctx.req, { fields: ["list", "create", "delete"], unknownCode: "invalid_body" });
  const db = ctx.store.db;
  if (data.list === true) return ctx.json(ctx.res, 200, { ok: true, views: listViews(db, { roomId }) });
  if (typeof data.delete === "string") {
    const view = getView(db, { roomId, viewId: data.delete });
    if (!view) ctx.reject(404, "unknown_view", "No such view in this room");
    const ownerId = ctx.store.roomAuthority(roomId).ownerId;
    if (view.createdBy !== auth.member.id && ownerId !== auth.member.id) ctx.reject(403, "not_view_creator", "Only the view's creator or the room owner can delete it");
    deleteView(db, { roomId, viewId: data.delete });
    return ctx.json(ctx.res, 200, { ok: true, viewId: data.delete, deleted: true });
  }
  if (data.create && typeof data.create === "object") {
    const { name } = data.create;
    if (typeof name !== "string" || name.trim().length === 0) ctx.reject(422, "invalid_name", "name must be a non-empty string");
    const query = viewQueryOf(data.create.query);
    if (!query) ctx.reject(422, "invalid_query", `query is an object of Board list params: ${VIEW_QUERY_KEYS.join(", ")}`);
    return ctx.json(ctx.res, 201, { ok: true, view: createView(db, { roomId, name: name.trim(), query, createdBy: auth.member.id }) });
  }
  ctx.reject(422, "invalid_body", "Pass one of list, create, delete");
}

export const BOARD_VIEW_ROUTES = Object.freeze([
  Object.freeze({ id: "board-views.admin", method: "POST", path: "/api/rooms/{roomId}/board-views",
    auth: "room", capability: null, scope: "room", handler: postBoardViews,
    parity: "exempt:human-curated Board views; agents pass the same list params to room_list_work/REST directly",
    schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }, body: { type: "object" }, response: { type: "object" } },
    events: [] }),
]);
