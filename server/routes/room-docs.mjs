// Room docs routes. OFF unless ROOM_DOCS=1. See server/room-docs.mjs.
// GET  /api/rooms/{roomId}/docs            list (no bodies)
// GET  /api/rooms/{roomId}/docs/{docId}    one doc; ?rev=n for a past revision
// POST /api/rooms/{roomId}/docs/{docId}    {title, body, baseRev} create (baseRev 0) or update
import { listDocs, getDoc, writeDoc, DOC_ID, MAX_TITLE, MAX_BODY } from "../room-docs.mjs";

function authed(ctx, { write }) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const check = auth => {
    if (!auth?.member?.id || auth.member.active === false) ctx.reject(401, "unauthenticated", "Room membership required");
    if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
    const need = write ? ["rooms:write", "rooms:*"] : ["rooms:read", "rooms:write", "rooms:*"];
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(scope => need.includes(scope))) {
      ctx.reject(403, "insufficient_scope", `API key lacks ${write ? "rooms:write" : "rooms:read"}`);
    }
  };
  const auth = ctx.roomAuth(selected, roomId, fence);
  check(auth);
  if (write) ctx.protectWrite(ctx.req, auth, selected.bearer);
  ctx.rate(`${write ? "write" : "read"}:${auth.credentialHash}`, write ? 60 : 240);
  if (ctx.roomDocsEnabled !== true) ctx.reject(404, "not_found", "Not found");
  return { roomId, selected, fence, auth, check };
}

const docIdOf = ctx => {
  const docId = ctx.params.docId;
  if (typeof docId !== "string" || !DOC_ID.test(docId)) ctx.reject(422, "invalid_body", "docId must be 1..64 of [a-z0-9-], starting alphanumeric");
  return docId;
};

export async function getRoomDocs(ctx) {
  const { roomId } = authed(ctx, { write: false });
  if ([...ctx.url.searchParams.keys()].some(key => !["limit", "after", "auth"].includes(key) || ctx.url.searchParams.getAll(key).length !== 1)) ctx.reject(422, "invalid_query", "Only one limit, after and auth parameter are accepted");
  const authMode = ctx.url.searchParams.get("auth");
  if (authMode !== null && !["room", "account"].includes(authMode)) ctx.reject(422, "invalid_auth_mode", "Invalid Room authentication mode");
  const limitRaw = ctx.url.searchParams.get("limit");
  const limit = limitRaw === null ? 100 : Number(limitRaw);
  const after = ctx.url.searchParams.get("after") ?? "";
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (after !== "" && !DOC_ID.test(after))) {
    ctx.reject(422, "invalid_query", "limit must be 1..500; after must be a document id from nextAfter");
  }
  return ctx.json(ctx.res, 200, { ok: true, ...listDocs(ctx.store.db, { roomId, limit, after }) });
}

export async function getRoomDoc(ctx) {
  const { roomId } = authed(ctx, { write: false });
  const docId = docIdOf(ctx);
  const revRaw = ctx.url.searchParams.get("rev");
  const rev = revRaw === null ? null : Number(revRaw);
  if (rev !== null && !(Number.isSafeInteger(rev) && rev >= 1)) ctx.reject(422, "invalid_body", "rev must be a positive integer");
  const doc = getDoc(ctx.store.db, { roomId, docId, rev });
  if (!doc) ctx.reject(404, "unknown_doc", "No such doc (or revision) in this room");
  return ctx.json(ctx.res, 200, { ok: true, doc });
}

export async function postRoomDoc(ctx) {
  let { roomId, selected, fence, auth, check } = authed(ctx, { write: true });
  const docId = docIdOf(ctx);
  const data = await ctx.body(ctx.req, { fields: ["title", "body", "baseRev"], unknownCode: "invalid_body" });
  const current = ctx.roomAuth(selected, roomId, fence);
  check(current);
  if (current.member.id !== auth.member.id) ctx.reject(403, "access_denied", "The acting member changed");
  ctx.protectWrite(ctx.req, current, selected.bearer);
  auth = current;
  if (!data || typeof data !== "object") ctx.reject(422, "invalid_body", "Body must be an object");
  if (typeof data.title !== "string" || !data.title.trim() || data.title.length > MAX_TITLE) ctx.reject(422, "invalid_body", `title must be 1..${MAX_TITLE} characters`);
  if (typeof data.body !== "string" || data.body.length > MAX_BODY) ctx.reject(422, "invalid_body", `body must be a string of at most ${MAX_BODY} characters`);
  if (!Number.isSafeInteger(data.baseRev) || data.baseRev < 0) ctx.reject(422, "invalid_body", "baseRev must be the rev you read (0 to create)");
  const result = writeDoc(ctx.store, { roomId, docId, title: data.title.trim(), body: data.body, baseRev: data.baseRev, author: auth.member.id });
  if (result.conflict !== undefined) ctx.reject(409, "doc_rev_conflict", `Doc is at rev ${result.conflict}; read it and retry with that baseRev`);
  return ctx.json(ctx.res, data.baseRev === 0 ? 201 : 200, { ok: true, doc: result.doc });
}

const params = names => ({ type: "object", required: names, properties: Object.fromEntries(names.map(n => [n, { type: "string" }])) });
const EXEMPT = "exempt:flagged preview; MCP doc tools follow once the HTTP shape settles";
export const ROOM_DOC_ROUTES = Object.freeze([
  Object.freeze({ id: "room-docs-list", method: "GET", path: "/api/rooms/{roomId}/docs", auth: "room", capability: null, scope: "room",
    handler: getRoomDocs, parity: EXEMPT, schema: { params: params(["roomId"]), query: { type: "object", properties: { auth: { type: "string", enum: ["room", "account"] }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 }, after: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" } } }, response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "room-docs-get", method: "GET", path: "/api/rooms/{roomId}/docs/{docId}", auth: "room", capability: null, scope: "room",
    handler: getRoomDoc, parity: EXEMPT, schema: { params: params(["roomId", "docId"]), response: { type: "object" } }, events: [] }),
  Object.freeze({ id: "room-docs-write", method: "POST", path: "/api/rooms/{roomId}/docs/{docId}", auth: "room", capability: null, scope: "room",
    handler: postRoomDoc, parity: EXEMPT, schema: { params: params(["roomId", "docId"]), body: { type: "object" }, response: { type: "object" } }, events: [] }),
]);
