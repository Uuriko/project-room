// Inbound task hooks (Linear-parity). OFF unless ROOM_INBOUND_HOOKS=1.
// POST /api/rooms/{roomId}/inbound-hooks — room owner creates {target} or
//   revokes {revoke: hookId}, or lists {list: true} (no secrets). The whsec_ secret is returned once, on create.
// POST /api/inbound/{hookId} — signed MCP Events delivery opens a Board task.
import { createInboundHook, revokeInboundHook, listInboundHooks, inboundHooksEnabled, postInboundHook, InboundKeyMissing } from "../inbound-task-hooks.mjs";
import { ownMember } from "../../src/events.js";

export async function postInboundHookAdmin(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`write:${auth.credentialHash}`, 60);
  if (!inboundHooksEnabled()) ctx.reject(404, "not_found", "Not found");
  const authority = ctx.store.roomAuthority(roomId);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_only", "Only the room owner can manage inbound hooks");
  const data = await ctx.body(ctx.req, { fields: ["target", "revoke", "list"], unknownCode: "invalid_body" });
  if (data.list === true) return ctx.json(ctx.res, 200, { ok: true, hooks: listInboundHooks(ctx.store.db, { roomId }) });
  if (typeof data.revoke === "string") {
    return ctx.json(ctx.res, 200, { ok: true, revoked: revokeInboundHook(ctx.store.db, { roomId, hookId: data.revoke }) });
  }
  const target = ownMember(authority.members ?? {}, typeof data.target === "string" ? data.target : auth.member.id);
  if (!target || target.active === false) ctx.reject(422, "unknown_member", "target must be an active room member");
  let hook;
  try { hook = createInboundHook(ctx.store.db, { roomId, targetMember: target.id, createdBy: auth.member.id }); }
  catch (e) { if (e instanceof InboundKeyMissing) ctx.reject(503, "inbound_hooks_unavailable", "Inbound hooks are not configured"); throw e; }
  return ctx.json(ctx.res, 201, { ok: true, ...hook, target: target.id });
}

export const INBOUND_HOOK_ROUTES = Object.freeze([
  Object.freeze({ id: "inbound-hooks.admin", method: "POST", path: "/api/rooms/{roomId}/inbound-hooks",
    auth: "room", capability: null, scope: "room", handler: postInboundHookAdmin,
    parity: "exempt:owner-only integration setup that returns a signing secret once; not exposed as an agent tool",
    schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }, body: { type: "object" }, response: { type: "object" } },
    events: [] }),
  Object.freeze({ id: "inbound-hooks.deliver", method: "POST", path: "/api/inbound/{hookId}",
    auth: "none", capability: null, scope: "worker", handler: ctx => postInboundHook(ctx),
    parity: "exempt:third-party signed webhook receiver, not a member or agent action",
    schema: { params: { type: "object", required: ["hookId"], properties: { hookId: { type: "string" } } }, body: { type: "object" }, response: { type: "object" } },
    events: ["work_claim.updated"] }),
]);
