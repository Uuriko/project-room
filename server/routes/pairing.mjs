// Pairing doors. Open routes are the agent's fetch and poll. Approval and
// merge stay on a room credential. RFC 8628 poll errors are a raw JSON body.
import { PairPollError } from "../pairing.mjs";

const string = { type: "string" };
const object = { type: "object" };

function originOf(ctx) {
  try { return ctx.expectedOrigin(); }
  catch { return null; }
}

function send(ctx, status, body) {
  return ctx.json(ctx.res, status, body);
}

async function readPairBody(ctx) {
  const type = String(ctx.req.headers["content-type"] ?? "");
  if (type.includes("application/x-www-form-urlencoded")) {
    const text = await ctx.readText(ctx.req);
    const params = new URLSearchParams(text);
    const body = {};
    for (const [key, value] of params) body[key] = value;
    return body;
  }
  return ctx.body(ctx.req);
}

function csrfOk(auth, presented) {
  return auth?.kind === "session" && typeof presented === "string" && presented.length > 0 && presented === auth.csrf;
}

async function startPair(ctx) {
  const query = ctx.url.searchParams;
  const body = ctx.req.method === "POST" ? await readPairBody(ctx) : {};
  const roomId = body.room ?? body.roomId ?? query.get("room");
  const displayName = body.name ?? body.displayName ?? query.get("name");
  const result = ctx.store.pairing.start({
    roomId, displayName,
    publicKey: body.publicKey ?? query.get("publicKey"),
    keyProof: body.keyProof ?? query.get("keyProof"),
    credential: body.credential ?? null,
    address: ctx.remoteAddress,
    origin: originOf(ctx)
  });
  if (result.connection) return send(ctx, 200, { ...result.connection, origin: result.connection.origin ?? originOf(ctx) });
  return send(ctx, 200, result);
}

async function pollPair(ctx) {
  const presented = ctx.url.searchParams.get("secret") ?? ctx.req.headers.authorization?.replace(/^bearer\s+/i, "");
  try {
    const connection = ctx.store.pairing.poll(ctx.params.pairId, presented, { origin: originOf(ctx) });
    return send(ctx, 200, connection);
  } catch (error) {
    if (error instanceof PairPollError || error?.rfc8628) {
      ctx.res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      ctx.res.end(JSON.stringify({ error: error.code }));
      return;
    }
    throw error;
  }
}

function approver(ctx, roomId) {
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!selected.bearer) ctx.protectWrite(ctx.req, auth, false);
  return { token: selected.token, binding: fence, bearer: selected.bearer };
}

async function decidePair(ctx) {
  const roomId = ctx.params.roomId;
  const body = await readPairBody(ctx);
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!selected.bearer && !csrfOk(auth, ctx.req.headers["x-csrf-token"] ?? body.csrf_token)) {
    ctx.reject(403, "csrf_denied", "Session confirmation required; sign in again");
  }
  if (!selected.bearer) ctx.checkOrigin(ctx.req, true);
  const result = ctx.store.pairing.decide(selected.token, roomId, {
    pairId: ctx.params.pairId ?? body.pairId ?? null,
    userCode: body.userCode ?? body.code ?? null,
    decision: body.decision,
    reconnect: body.reconnect === true || body.reconnect === "1" || body.reconnect === "true",
    profile: body.profile ?? "contribute"
  }, fence);
  if (body.csrf_token) return send(ctx, 200, { status: result.status, pairId: result.pairId, memberId: result.memberId ?? null, reconnected: Boolean(result.reconnected) });
  return send(ctx, 200, result.connection ? { ...result, connection: { ...result.connection, origin: originOf(ctx) } } : result);
}

function listPairs(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  ctx.roomAuth(selected, roomId, fence);
  return send(ctx, 200, ctx.store.pairing.list(selected.token, roomId, fence));
}

async function mergeMembers(ctx) {
  const roomId = ctx.params.roomId;
  const { token, binding } = approver(ctx, roomId);
  const body = await ctx.body(ctx.req);
  return send(ctx, 200, ctx.store.pairing.merge(token, roomId, body, binding));
}

async function setJoinPolicy(ctx) {
  const roomId = ctx.params.roomId;
  const { token, binding } = approver(ctx, roomId);
  const body = await ctx.body(ctx.req);
  return send(ctx, 200, ctx.store.pairing.setPolicy(token, roomId, body.mode, binding));
}

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function phonePage(ctx) {
  const code = ctx.params.userCode;
  const pending = ctx.store.pairing.peek(code);
  let csrf = "";
  let action = "";
  if (pending) {
    action = `/api/rooms/${encodeURIComponent(pending.roomId)}/pairs/decide`;
    try {
      const token = ctx.cookie(ctx.req, ctx.roomCookieName);
      if (token) {
        const auth = ctx.store.authenticate(token, pending.roomId);
        if (auth.csrf) csrf = auth.csrf;
      }
    } catch { /* a signed-out phone still shows the code */ }
  }
  const duplicate = pending?.possibleDuplicate
    ? `<p>${escape(pending.possibleDuplicate.displayName)} is already in this room.</p>
       <button name="reconnect" value="1" class="button" type="submit">Same agent, reconnect it</button>`
    : "";
  const duplicateNote = pending?.possibleDuplicate
    ? `<p>${escape(pending.possibleDuplicate.displayName)} is already in this room. Same agent, reconnect it.</p>`
    : "";
  const form = pending && csrf
    ? `<form method="post" action="${escape(action)}">
        <input type="hidden" name="userCode" value="${escape(pending.userCode)}">
        <input type="hidden" name="csrf_token" value="${escape(csrf)}">
        <input type="hidden" name="decision" value="approve">
        <button class="button" type="submit">Approve</button>
        ${duplicate}
       </form>
       <form method="post" action="${escape(action)}">
        <input type="hidden" name="userCode" value="${escape(pending.userCode)}">
        <input type="hidden" name="csrf_token" value="${escape(csrf)}">
        <input type="hidden" name="decision" value="deny">
        <button type="submit">Deny</button>
       </form>`
    : pending
      ? `<p>${escape(pending.displayName)} · ${escape(pending.userCode)}</p>${duplicateNote}<p>Sign in, then reload.</p>`
      : `<p>This code is not pending.</p>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair</title></head><body><h1>Pair</h1>${form}</body></html>`;
  ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
  ctx.res.end(html);
}

const roomParam = { type: "object", required: ["roomId"], properties: { roomId: string } };
const parityJoin = "mcp:room_join";

export const PAIRING_ROUTES = Object.freeze([
  Object.freeze({ id: "pair-start-get", publication: "open:pairing start serves no room content", method: "GET", path: "/api/pair", auth: "none", capability: null, scope: "public", handler: startPair, parity: parityJoin, schema: { query: object, response: object }, events: ["pair.requested"] }),
  Object.freeze({ id: "pair-start-post", publication: "open:pairing start creates a code and serves no room content", method: "POST", path: "/api/pair", auth: "none", capability: null, scope: "public", handler: startPair, parity: parityJoin, schema: { body: object, response: object }, events: ["pair.requested"] }),
  Object.freeze({ id: "pair-page-get", publication: "open:static pairing page with no room content", method: "GET", path: "/pair", auth: "none", capability: null, scope: "public", handler: startPair, parity: parityJoin, schema: { query: object, response: object }, events: ["pair.requested"] }),
  Object.freeze({ id: "pair-poll", publication: "open:pair status by unguessable pair id, no room content", method: "GET", path: "/api/pair/{pairId}", auth: "none", capability: null, scope: "public", handler: pollPair, parity: parityJoin, schema: { params: { type: "object", required: ["pairId"], properties: { pairId: string } }, response: object }, events: [] }),
  Object.freeze({ id: "pair-phone", publication: "open:approval page keyed by user code, no room content", method: "GET", path: "/pair/{userCode}", auth: "none", capability: null, scope: "public", handler: phonePage, parity: "exempt:phone approval page", schema: { params: { type: "object", required: ["userCode"], properties: { userCode: string } }, response: object }, events: [] }),
  Object.freeze({ id: "pair-list", method: "GET", path: "/api/rooms/{roomId}/pairs", auth: "room", capability: null, scope: "room", handler: listPairs, parity: "exempt:owner pending pair list", schema: { params: roomParam, response: object }, events: [] }),
  Object.freeze({ id: "pair-decide", method: "POST", path: "/api/rooms/{roomId}/pairs/{pairId}/decide", auth: "room", capability: null, scope: "room", handler: decidePair, parity: "exempt:owner approves one pair", schema: { params: { type: "object", required: ["roomId", "pairId"], properties: { roomId: string, pairId: string } }, body: object, response: object }, events: ["pair.approved", "pair.denied", "member.added"] }),
  Object.freeze({ id: "pair-decide-code", method: "POST", path: "/api/rooms/{roomId}/pairs/decide", auth: "room", capability: null, scope: "room", handler: decidePair, parity: "exempt:owner approves by user code", schema: { params: roomParam, body: object, response: object }, events: ["pair.approved", "pair.denied", "member.added"] }),
  Object.freeze({ id: "pair-join-policy", method: "POST", path: "/api/rooms/{roomId}/join-policy", auth: "room", capability: null, scope: "room", handler: setJoinPolicy, parity: "exempt:owner standing join policy", schema: { params: roomParam, body: object, response: object }, events: [] }),
  Object.freeze({ id: "members-merge", method: "POST", path: "/api/rooms/{roomId}/members/merge", auth: "room", capability: null, scope: "room", handler: mergeMembers, parity: "mcp:room_merge_members", schema: { params: roomParam, body: object, response: object }, events: ["member.merged"] })
]);
