// Code drop routes: room-native patch exchange (server/code-drops.mjs).
//
// Auth mirrors the room files routes in server/http.mjs: room credential,
// fence, roomAuth, no account bearer, browser session or room token, API-key
// rooms:read / rooms:write scope, CSRF on writes, then the rate limit.

import { mcpAttachmentBodyBytes } from "../room-attachment-bytes.mjs";

function access(ctx, { writing }) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req, null) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (!selected.bearer && auth.kind !== "session") ctx.reject(401, "unauthenticated", "Browser session required");
  if (auth.kind === "api-key") {
    const required = writing ? "rooms:write" : "rooms:read";
    const granted = (auth.apiKeyScopes ?? []).some(scope =>
      scope === required || (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))));
    if (!granted) ctx.reject(403, "insufficient_scope", `API key lacks the ${required} scope`);
  }
  if (writing) ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`${writing ? "write" : "read"}:${auth.credentialHash}`, writing ? 60 : 600);
  return { roomId, token: selected.token, fence };
}

const SHARE_FIELDS = new Set(["kind", "title", "data", "base", "branch", "claimId", "supersedes", "replyToId"]);
const CHECK_FIELDS = new Set(["applies", "onBase", "tests", "verdict", "note", "announce"]);

function onlyFields(ctx, data, fields) {
  if (!data || typeof data !== "object" || Array.isArray(data)) ctx.reject(422, "invalid_body", "A JSON object is required");
  for (const key of Object.keys(data)) if (!fields.has(key)) ctx.reject(422, "invalid_body", `${key} is not allowed`);
}

export async function shareCodeDrop(ctx) {
  const { roomId, token, fence } = access(ctx, { writing: true });
  const data = await ctx.body(ctx.req, { limit: mcpAttachmentBodyBytes });
  onlyFields(ctx, data, SHARE_FIELDS);
  const result = ctx.store.codeDrops.share(token, roomId, data, fence);
  return ctx.json(ctx.res, result.duplicate ? 200 : 201, result);
}

export function listCodeDrops(ctx) {
  const { roomId, token } = access(ctx, { writing: false });
  const params = ctx.url.searchParams;
  return ctx.json(ctx.res, 200, ctx.store.codeDrops.list(token, roomId, {
    claimId: params.get("claimId"), authorId: params.get("authorId"), limit: params.get("limit")
  }));
}

export function readCodeDrop(ctx) {
  const { roomId, token } = access(ctx, { writing: false });
  return ctx.json(ctx.res, 200, ctx.store.codeDrops.get(token, roomId, ctx.params.dropId));
}

export function rawCodeDrop(ctx) {
  const { roomId, token } = access(ctx, { writing: false });
  const { bytes, kind, sha256, filename } = ctx.store.codeDrops.raw(token, roomId, ctx.params.dropId);
  ctx.res.writeHead(200, {
    "Content-Type": kind === "bundle" ? "application/octet-stream" : "text/plain; charset=utf-8",
    "Content-Length": String(bytes.length),
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-SHA256": sha256,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-cache"
  });
  return ctx.res.end(bytes);
}

export async function checkCodeDrop(ctx) {
  const { roomId, token, fence } = access(ctx, { writing: true });
  const data = await ctx.body(ctx.req);
  onlyFields(ctx, data, CHECK_FIELDS);
  return ctx.json(ctx.res, 200, ctx.store.codeDrops.check(token, roomId, ctx.params.dropId, data, fence));
}

const roomParams = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const dropParams = Object.freeze({ type: "object", required: ["roomId", "dropId"],
  properties: { roomId: { type: "string" }, dropId: { type: "string" } } });
const shareBody = Object.freeze({ type: "object", required: ["kind", "title", "data"], additionalProperties: false,
  properties: { kind: { type: "string", enum: ["mbox", "diff", "bundle"] }, title: { type: "string" }, data: { type: "string" },
    base: { type: "string" }, branch: { type: "string" }, claimId: { type: "string" }, supersedes: { type: "string" },
    replyToId: { type: "string" } } });
const checkBody = Object.freeze({ type: "object", required: ["verdict"], additionalProperties: false,
  properties: { applies: { type: "string", enum: ["clean", "conflict", "skipped"] }, onBase: { type: "string" },
    tests: { type: "string" }, verdict: { type: "string", enum: ["approve", "changes", "comment"] },
    note: { type: "string" }, announce: { type: "boolean" } } });
const response = Object.freeze({ type: "object" });

function codeDropRoute(row) {
  return Object.freeze({ auth: "room", capability: null, scope: "room", events: [], ...row });
}

export const CODE_DROP_ROUTES = Object.freeze([
  codeDropRoute({ id: "code-drop-share", method: "POST", path: "/api/rooms/{roomId}/code", handler: shareCodeDrop,
    bodyLimit: mcpAttachmentBodyBytes, schema: { params: roomParams, body: shareBody, response }, events: ["message.posted"] }),
  codeDropRoute({ id: "code-drop-list", method: "GET", path: "/api/rooms/{roomId}/code", handler: listCodeDrops,
    schema: { params: roomParams, response } }),
  codeDropRoute({ id: "code-drop-read", method: "GET", path: "/api/rooms/{roomId}/code/{dropId}", handler: readCodeDrop,
    schema: { params: dropParams, response } }),
  codeDropRoute({ id: "code-drop-raw", method: "GET", path: "/api/rooms/{roomId}/code/{dropId}/raw", handler: rawCodeDrop,
    schema: { params: dropParams, response: { type: "string" } } }),
  codeDropRoute({ id: "code-drop-check", method: "POST", path: "/api/rooms/{roomId}/code/{dropId}/checks", handler: checkCodeDrop,
    schema: { params: dropParams, body: checkBody, response }, events: ["message.posted"] }),
]);
