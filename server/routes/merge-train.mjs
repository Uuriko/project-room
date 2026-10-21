// Merge train REST twin of the room_land MCP tool (server/merge-train.mjs).
// GET lists entries and batches; POST takes { action, ... } exactly like the
// tool. Same room credential rules as the land queue routes.

import { runMergeTrainAction } from "../mcp-room-profile.mjs";

const FIELDS = ["action", "repo", "prNumber", "claimantMemberId", "entryId", "batchId", "ok", "reason"];

function context(ctx, write) {
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
  if (auth.kind === "api-key") {
    const required = write ? "rooms:write" : "rooms:read";
    if (!(auth.apiKeyScopes ?? []).some(scope => scope === required || scope === "rooms:*")) {
      ctx.reject(403, "insufficient_scope", `API key lacks ${required}`);
    }
  }
  return { roomId, auth };
}

export function listMergeTrain(ctx) {
  const { roomId, auth } = context(ctx, false);
  const train = ctx.store.mergeTrain;
  if (ctx.url?.searchParams?.get("view") === "metrics") return ctx.json(ctx.res, 200, train.metrics(roomId, auth.member.id));
  return ctx.json(ctx.res, 200, train.list(roomId, auth.member.id));
}

export async function postMergeTrain(ctx) {
  const { roomId, auth } = context(ctx, true);
  const data = await ctx.body(ctx.req);
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).every(key => FIELDS.includes(key))) {
    ctx.reject(422, "invalid_request", "action is required; see the room_land tool for fields");
  }
  const result = await runMergeTrainAction(ctx.store, roomId, auth.member.id, data);
  return ctx.json(ctx.res, data.action === "enqueue" && !result.duplicate ? 201 : 200, result);
}

const parameters = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const PATH = "/api/rooms/{roomId}/room_land";

export const MERGE_TRAIN_ROUTES = Object.freeze([
  Object.freeze({ id: "list-merge-train", method: "GET", path: PATH,
    auth: "room", capability: null, scope: "room", handler: listMergeTrain, parity: "mcp:room_land",
    schema: { params: parameters, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "post-merge-train", method: "POST", path: PATH,
    auth: "room", capability: null, scope: "room", handler: postMergeTrain, parity: "mcp:room_land",
    schema: { params: parameters, body: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["enqueue", "list", "approve", "remove", "smoke", "pause", "resume", "metrics"] }, reason: { type: "string" },
      repo: { type: "string" }, prNumber: { type: "integer" }, claimantMemberId: { type: "string" },
      entryId: { type: "string" }, batchId: { type: "string" }, ok: { type: "boolean" }
    } }, response: { type: "object" } }, events: [] })
]);
