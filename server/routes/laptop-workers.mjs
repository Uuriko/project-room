import { laptopWorkers } from "../laptop-workers.mjs";
async function workers(ctx) {
  const { roomId } = ctx.params, writing = ctx.req.method === "POST";
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const authenticate = () => {
    const auth = ctx.roomAuth(selected, roomId, fence);
    if (!auth?.member?.id || !selected.bearer || auth.credentialScope !== "room") ctx.reject(403, "room_bearer_required", "A room credential is required");
    const scope = writing ? "rooms:write" : "rooms:read";
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(value => [scope, "rooms:*"].includes(value))) ctx.reject(403, "insufficient_scope", "Required room scope is absent");
    if (writing) ctx.protectWrite(ctx.req, auth, selected.bearer);
    return auth;
  };
  const first = authenticate(); ctx.rate(`laptop-worker:${first.credentialHash}`, 120);
  const data = writing ? await ctx.body(ctx.req, { limit: 16384 }) : undefined;
  const current = authenticate(); if (current.member.id !== first.member.id) ctx.reject(403, "identity_changed", "Identity changed");
  return ctx.json(ctx.res, 200, laptopWorkers(ctx.store, roomId, current.member.id, data));
}
export const LAPTOP_WORKER_ROUTES = Object.freeze(["GET", "POST"].map(method => Object.freeze({
  id: `laptop-workers-${method.toLowerCase()}`, method, path: "/api/rooms/{roomId}/laptop-workers",
  auth: "room", capability: null, scope: "room", handler: workers, bodyLimit: 16384,
  schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }, response: { type: "object" } },
  events: [], parity: "exempt:host capability discovery for deterministic local jobs",
})));
