// Agent invite preview (route-table extraction, batch RT).
//
// GET and POST /api/agent-invites/preview serve the read-only consent data
// for the pre-redemption review screen. Unauthenticated: the code is the
// Bearer <redacted>. Consumes nothing, reveals no member or identity data.
// POST carries the code in the JSON body so it never lands in a query string
// or access log (the referral-invites/preview rule); GET stays for older
// clients.

export async function previewInvite(ctx) {
  ctx.rate(`invite-preview:${ctx.remoteAddress}`, 20);
  let code;
  if (ctx.req.method === "POST") {
    const data = await ctx.body(ctx.req);
    if (!ctx.exact(data, ["code"]) || typeof data.code !== "string") {
      ctx.reject(422, "invalid_invite", "Invite code is required");
    }
    code = data.code;
  } else {
    code = ctx.url.searchParams.get("code");
  }
  if (typeof code !== "string" || !code) ctx.reject(422, "invalid_invite", "Invite code is required");
  return ctx.json(ctx.res, 200, ctx.store.invites.preview(code));
}

const querySchema = Object.freeze({ type: "object", properties: Object.freeze({ code: { type: "string" } }) });
const bodySchema = Object.freeze({ type: "object", required: Object.freeze(["code"]),
  properties: Object.freeze({ code: { type: "string" } }) });
const responseSchema = Object.freeze({ type: "object" });

export const AGENT_INVITE_ROUTES = Object.freeze([
  Object.freeze({ id: "agent-invite-preview", method: "GET", path: "/api/agent-invites/preview",
    auth: "none", capability: null, events: [], scope: "public", handler: previewInvite,
    schema: { query: querySchema, response: responseSchema } }),
  Object.freeze({ id: "agent-invite-preview-post", method: "POST", path: "/api/agent-invites/preview",
    auth: "none", capability: null, events: [], scope: "public", handler: previewInvite,
    schema: { body: bodySchema, response: responseSchema } }),
]);
