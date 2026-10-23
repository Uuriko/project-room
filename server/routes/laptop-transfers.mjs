import { laptopTransfer } from "../laptop-transfers.mjs";
import { enforceAutonomyTierForAction } from "../autonomy-tiers.mjs";
import { isGuestAgentMemberId } from "../guest-agent-links.mjs";

async function transfer(ctx) {
  const { roomId, transferId } = ctx.params;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const authenticate = () => {
    const auth = ctx.roomAuth(selected, roomId, fence);
    if (!auth?.member?.id || !selected.bearer || auth.credentialScope !== "room") ctx.reject(403, "room_bearer_required", "A room credential is required");
    if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, "guest_scope_denied", "Guest members cannot transfer laptop files");
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => ["rooms:write", "rooms:*"].includes(scope))) ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    enforceAutonomyTierForAction({ db: ctx.store.db, roomId, state: ctx.store.room(roomId).state, actor: auth.member,
      action: "room_put_file", fail: ctx.reject });
    return auth;
  };
  const initial = authenticate();
  ctx.rate(`laptop-transfer:${initial.credentialHash}`, 600);
  const data = await ctx.body(ctx.req, { limit: 710000 });
  const current = authenticate();
  if (current.member.id !== initial.member.id) ctx.reject(403, "identity_changed", "Identity changed during upload");
  return ctx.json(ctx.res, 200, laptopTransfer(ctx.store, roomId, current.member.id, transferId, data));
}

export const LAPTOP_TRANSFER_ROUTES = Object.freeze([
  Object.freeze({ id: "laptop-transfer", method: "POST", path: "/api/rooms/{roomId}/laptop-transfers/{transferId}",
    auth: "room", capability: null, scope: "room", handler: transfer, bodyLimit: 710000,
    schema: { params: { type: "object", required: ["roomId", "transferId"], properties: { roomId: { type: "string" }, transferId: { type: "string" } } },
      body: { type: "object" }, response: { type: "object" } }, events: [],
    parity: "exempt:host-only transient artifact transport; no durable bytes in Room" }),
]);
