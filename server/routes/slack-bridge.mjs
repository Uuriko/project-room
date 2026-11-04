// Slack bridge routes. OFF unless ROOM_SLACK_BRIDGE=1. See server/slack-bridge.mjs.
// POST /api/rooms/{roomId}/slack-link  owner: {get:true} | {link:{teamId, channelId, memberId}} | {unlink:true}
// POST /api/slack/events               Slack Events API receiver (signed)
import { slackBridgeEnabled, slackSecretsMissing, getLink, setLink, removeLink, verifySlack, handleSlackEvent, SLACK_ID } from "../slack-bridge.mjs";

const SLACK_BODY_LIMIT = 64 * 1024;

export async function postSlackLink(ctx) {
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
  ctx.rate(`write:${auth.credentialHash}`, 30);
  if (!slackBridgeEnabled()) ctx.reject(404, "not_found", "Not found");
  const data = await ctx.body(ctx.req, { fields: ["get", "link", "unlink"], unknownCode: "invalid_body" });
  const current = ctx.roomAuth(selected, roomId, fence);
  checkAuth(current);
  if (current.member.id !== auth.member.id) ctx.reject(403, "access_denied", "The acting member changed");
  ctx.protectWrite(ctx.req, current, selected.bearer);
  auth = current;
  const authority = ctx.store.roomAuthority(roomId);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "access_denied", "Only the room owner can manage the Slack link");
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 1) ctx.reject(422, "invalid_body", "Pass exactly one of get, link, unlink");
  const db = ctx.store.db;
  const missing = slackSecretsMissing();
  if (data.get === true) return ctx.json(ctx.res, 200, { ok: true, link: getLink(db, roomId), missingSecrets: missing });
  if (data.unlink === true) return ctx.json(ctx.res, 200, { ok: true, removed: removeLink(db, roomId) });
  const l = data.link;
  if (!l || typeof l !== "object" || !SLACK_ID.test(String(l.teamId ?? "")) || !SLACK_ID.test(String(l.channelId ?? "")) || typeof l.memberId !== "string") {
    ctx.reject(422, "invalid_body", "link needs teamId and channelId (Slack ids) and memberId");
  }
  const member = authority.members?.[l.memberId];
  if (!member || member.active === false) ctx.reject(422, "invalid_body", "memberId must be an active member of this room");
  const out = setLink(ctx.store, { roomId, teamId: l.teamId, channelId: l.channelId, bridgeMember: l.memberId, createdBy: auth.member.id });
  if (out.taken) ctx.reject(409, "slack_channel_taken", "That Slack channel is already linked to another room");
  return ctx.json(ctx.res, 201, { ok: true, link: out.link, missingSecrets: missing });
}

export async function postSlackEvents(ctx, { env = process.env, now = Date.now() } = {}) {
  if (!slackBridgeEnabled(env)) ctx.reject(404, "not_found", "Not found");
  ctx.rate?.(`slack-events:${ctx.remoteAddress ?? "unknown"}`, 600);
  if (!env.SLACK_SIGNING_SECRET) ctx.reject(503, "slack_not_configured", "The Slack bridge is not configured on this server");
  const text = await ctx.readText(ctx.req, SLACK_BODY_LIMIT, () => ctx.reject(413, "too_large", "Request is too large"));
  const bad = verifySlack({ secret: env.SLACK_SIGNING_SECRET, headers: ctx.req.headers, body: text, nowS: Math.floor(now / 1000) });
  if (bad) ctx.reject(401, "webhook_signature", bad);
  let payload;
  try { payload = JSON.parse(text); } catch { ctx.reject(422, "invalid_json", "Expected a Slack Events API JSON payload"); }
  return ctx.json(ctx.res, 200, handleSlackEvent(ctx.store, payload, now));
}

export const SLACK_BRIDGE_ROUTES = Object.freeze([
  Object.freeze({ id: "slack-link", method: "POST", path: "/api/rooms/{roomId}/slack-link",
    auth: "room", capability: null, scope: "room", handler: postSlackLink,
    parity: "exempt:owner-only integration setup; not exposed as an agent tool",
    schema: { params: { type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } }, body: { type: "object" }, response: { type: "object" } },
    events: [] }),
  Object.freeze({ id: "slack-events", method: "POST", path: "/api/slack/events",
    auth: "none", capability: null, scope: "worker", handler: ctx => postSlackEvents(ctx),
    parity: "exempt:third-party signed webhook receiver, not a member or agent action",
    schema: { body: { type: "object" }, response: { type: "object" } },
    events: ["message.posted"] }),
]);
