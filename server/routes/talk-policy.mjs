// #5384: per-agent who-can-talk setting (read by any member, changed by the
// agent's owner or the room owner). Enforcement lives at wake fan-out in
// server/store.mjs; these routes only read and write the setting.

function roomContext(ctx, write) {
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
  return { roomId, selected, fence };
}

export async function readTalkPolicyRoute(ctx) {
  const { roomId, selected, fence } = roomContext(ctx, false);
  return ctx.json(ctx.res, 200, ctx.store.talkPolicy(selected.token, roomId, ctx.params.memberId, fence));
}

export async function writeTalkPolicyRoute(ctx) {
  const { roomId, selected, fence } = roomContext(ctx, true);
  const data = await ctx.body(ctx.req);
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !["policy", "allowed"].includes(key)))
    ctx.reject(422, "invalid_talk_policy", "policy (owner, members, room, nobody) and optional allowed (member ids) are the accepted fields");
  return ctx.json(ctx.res, 200, ctx.store.setTalkPolicy(selected.token, roomId, ctx.params.memberId, data, fence));
}

const string = { type: "string" };
const params = { type: "object", required: ["roomId", "memberId"], properties: { roomId: string, memberId: string } };
const policy = { type: "string", enum: ["owner", "members", "room", "nobody"] };

export const TALK_POLICY_ROUTES = Object.freeze([
  Object.freeze({ id: "talk-policy-read", method: "GET", path: "/api/rooms/{roomId}/members/{memberId}/talk-policy",
    auth: "room", capability: null, scope: "room", handler: readTalkPolicyRoute, parity: "exempt:owner setting read",
    schema: { params, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "talk-policy-write", method: "PUT", path: "/api/rooms/{roomId}/members/{memberId}/talk-policy",
    auth: "room", capability: null, scope: "room", handler: writeTalkPolicyRoute, parity: "exempt:owner setting write",
    schema: { params, body: { type: "object", required: ["policy"], properties: { policy, allowed: { type: "array", items: string } } }, response: { type: "object" } },
    events: [] }),
]);
