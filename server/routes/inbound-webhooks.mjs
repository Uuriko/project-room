// Inbound channel webhooks (missing-features #7): per-room webhook URLs that
// accept HMAC-SHA256-signed POSTs from third parties (Discord's lowest-friction
// integration) and deliver a message into the room as the webhook's own agent
// member. Rich message cards ride on message.posted as a validated card
// object. Declarative route table rows (batch RT) — new routes land here,
// never in the legacy chain in server/http.mjs.
import { randomUUID, randomBytes } from "node:crypto";
import { verifySignatureHeader, parseDeliverPayload, InboundWebhookError } from "../inbound-webhooks.mjs";
import { memberCan } from "../../src/events.js";

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.name = "ServiceError"; this.status = status; this.code = code; }
}

const hookError = (ctx, error) => {
  if (error instanceof InboundWebhookError) {
    const status = error.code === "unknown_webhook" ? 404
      : error.code === "payload_too_large" ? 413 : 422;
    ctx.reject(status, error.code, error.message);
  }
  throw error;
};

function hookAuthz(ctx, roomId) {
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req, null) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth.member?.id) ctx.reject(401, "unauthenticated", "Sign in to manage inbound webhooks");
  const authority = ctx.store.room(roomId).state;
  const canManage = auth.member.id === authority.room.ownerId
    || memberCan(authority, auth.member.id, "manage_members");
  return { selected, fence, auth, canManage };
}

// Delivery: unauthenticated by session — the HMAC signing secret is the
// credential. Fail closed on anything unsigned or malformed.
export async function inboundWebhookDeliver(ctx) {
  const { req, res, store } = ctx;
  const roomId = ctx.params.roomId;
  const webhookId = ctx.params.webhookId;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
    ctx.reject(415, "json_required", "Use application/json");
  }
  ctx.rate(`inbound-hook:${roomId}:${webhookId}`, 60);
  let hook;
  try {
    hook = store.inboundWebhooks.getForDelivery(webhookId);
  } catch (error) { hookError(ctx, error); }
  if (hook.roomId !== roomId) ctx.reject(404, "unknown_webhook", "Unknown webhook");
  const rawText = await ctx.readText(req, 65536, () => new ServiceError(413, "too_large", "Request is too large"));
  const raw = Buffer.from(rawText, "utf8");
  if (!verifySignatureHeader(hook.secret, req.headers["x-signature-256"], raw)) {
    ctx.reject(401, "bad_signature", "Missing or invalid X-Signature-256 header");
  }
  let payload;
  try {
    payload = parseDeliverPayload(raw);
  } catch (error) { hookError(ctx, error); }
  const deliverCommand = () => ({
    id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body: payload.text,
      ...(payload.card ? { card: payload.card } : {}) },
  });
  let result;
  try {
    result = store.command(hook.postToken, roomId, deliverCommand());
  } catch (error) {
    if (error?.code === "unauthenticated" || error?.status === 401) {
      // The server-held posting token lapsed (30-day rotation): rotate it and
      // retry once, so integrations do not silently die.
      const fresh = store.insertCredential(roomId, hook.memberId, "access", null,
        store.now() + 30 * 86400000);
      store.inboundWebhooks.updatePostToken(hook.webhookId, fresh);
      result = store.command(fresh, roomId, deliverCommand());
    } else throw error;
  }
  return ctx.json(res, result.duplicate ? 200 : 201,
    { messageId: result.event?.data?.messageId ?? null, sequence: result.sequence });
}

// Management: authenticated room members; create/revoke need manage_members
// (a webhook posts as a new room member).
export async function inboundWebhookManage(ctx) {
  const { req, res, store } = ctx;
  const roomId = ctx.params.roomId;
  const { selected, fence, auth, canManage } = hookAuthz(ctx, roomId);
  if (ctx.params.webhookId) {
    if (ctx.req.method !== "DELETE") ctx.reject(405, "method_not_allowed", "Method not allowed", { Allow: "POST, DELETE" });
    if (!canManage) ctx.reject(403, "access_denied", "Managing inbound webhooks requires manage_members");
    ctx.rate(`inbound-hook-manage:${auth.credentialHash}`, 20);
    try {
      return ctx.json(res, 200, store.inboundWebhooks.revoke(ctx.params.webhookId));
    } catch (error) { hookError(ctx, error); }
  }
  if (ctx.req.method === "GET") {
    ctx.rate(`inbound-hook-read:${auth.credentialHash}`, 60);
    return ctx.json(res, 200, { webhooks: store.inboundWebhooks.listForRoom(roomId) });
  }
  if (ctx.req.method === "POST") {
    if (!canManage) ctx.reject(403, "access_denied", "Managing inbound webhooks requires manage_members");
    ctx.rate(`inbound-hook-manage:${auth.credentialHash}`, 20);
    const data = await ctx.body(req);
    if (!data || typeof data.name !== "string" || Object.keys(data).length !== 1) {
      ctx.reject(422, "invalid_webhook", "Supply exactly { name }");
    }
    const name = data.name.trim();
    if (!name || name.length > 80) ctx.reject(422, "invalid_webhook", "name must be 1-80 characters");
    try {
      // The webhook posts as its own agent member: clean attribution,
      // flood control, and markdown all come free. The posting token
      // is server-held — the third party only ever sees the URL and
      // the signing secret.
      const memberId = `wh_${randomBytes(12).toString("hex")}`;
      store.command(selected.token, roomId, {
        id: randomUUID(), type: "member.added",
        data: { memberId, displayName: name, kind: "agent", permissions: [] },
      }, fence);
      const postToken = store.insertCredential(roomId, memberId, "access", null,
        store.now() + 30 * 86400000);
      const created = store.inboundWebhooks.create(
        { roomId, memberId, name, postToken });
      return ctx.json(res, 201, {
        webhookId: created.webhookId,
        url: `/api/rooms/${roomId}/inbound-webhooks/${created.webhookId}`,
        secret: created.secret,
        note: "Save the secret now — it is shown once. Sign the raw request body with HMAC-SHA256 and send it as the X-Signature-256 header (sha256=<hex>).",
      });
    } catch (error) { hookError(ctx, error); }
  }
  ctx.reject(405, "method_not_allowed", "Method not allowed", { Allow: "GET, POST" });
}

const PARAMS = {
  params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } },
  response: { type: "object" },
};

export const INBOUND_WEBHOOK_ROUTES = Object.freeze([
  Object.freeze({ id: "inbound-webhooks-list", method: "GET", path: "/api/rooms/{roomId}/inbound-webhooks",
    auth: "room", capability: null, scope: "room", handler: inboundWebhookManage,
    schema: PARAMS, events: [] }),
  Object.freeze({ id: "inbound-webhooks-create", method: "POST", path: "/api/rooms/{roomId}/inbound-webhooks",
    auth: "room", capability: null, scope: "room", handler: inboundWebhookManage,
    schema: { ...PARAMS, body: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false } }, events: [] }),
  Object.freeze({ id: "inbound-webhook-deliver", method: "POST", path: "/api/rooms/{roomId}/inbound-webhooks/{webhookId}",
    auth: "none", capability: null, scope: "room", handler: inboundWebhookDeliver, bodyLimit: 65536,
    schema: { params: { type: "object", required: ["roomId", "webhookId"], properties: { roomId: { type: "string" }, webhookId: { type: "string" } } }, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "inbound-webhook-revoke", method: "DELETE", path: "/api/rooms/{roomId}/inbound-webhooks/{webhookId}",
    auth: "room", capability: null, scope: "room", handler: inboundWebhookManage,
    schema: { params: { type: "object", required: ["roomId", "webhookId"], properties: { roomId: { type: "string" }, webhookId: { type: "string" } } }, response: { type: "object" } }, events: [] }),
]);
