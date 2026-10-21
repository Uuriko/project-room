// Drafts by default (Town-style): anything an agent would send out of Room
// (email, Slack, a PR comment, a text) lands as a draft card first, unless
// the room owner has allowed that agent to send.
//
// GET  /api/rooms/{roomId}/outbound-policy        { policies: [{ memberId, allowSend }] } (default false)
// PUT  /api/rooms/{roomId}/outbound-policy        { requestId, agentId, allowSend } room owner only
// POST /api/rooms/{roomId}/outbound               { requestId, channel, to, subject?, body }
//        allowed  -> 200 { mode: "send" }: the agent sends it itself
//        default  -> 201 { mode: "draft", draft }: nothing leaves Room
// GET  /api/rooms/{roomId}/outbound[?state=draft]  draft cards, newest first
// POST /api/rooms/{roomId}/outbound/{draftId}/decision  { decision: approve|discard, body? } owner only
// POST /api/rooms/{roomId}/outbound/{draftId}/sent      the author records it sent (approved only)
import { ownMember } from "../../src/events.js";
import { randomUUID } from "node:crypto";

export const OUTBOUND_CHANNELS = Object.freeze(["email", "slack", "github", "sms", "other"]);
const STATES = Object.freeze(["draft", "approved", "discarded", "sent"]);
const SCHEMA = `CREATE TABLE IF NOT EXISTS outbound_policies (
  room_id TEXT NOT NULL, member_id TEXT NOT NULL, allow_send INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, member_id));
CREATE TABLE IF NOT EXISTS outbound_drafts (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_id TEXT NOT NULL, request_id TEXT NOT NULL, channel TEXT NOT NULL,
  recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, state TEXT NOT NULL, decided_by TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(room_id, author_id, request_id))`;
const ready = new WeakSet();
export function ensureOutbound(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

function access(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(s => s === "rooms:write" || s === "rooms:*")) ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    ctx.rate(`write:${auth.credentialHash}`, 60);
  } else ctx.rate(`read:${auth.credentialHash}`, 600);
  return { roomId, auth, authority: ctx.store.roomAuthority(roomId) };
}

export function allowsSend(db, roomId, memberId) {
  return ensureOutbound(db).prepare("SELECT allow_send FROM outbound_policies WHERE room_id=? AND member_id=?").get(roomId, memberId)?.allow_send === 1;
}
const view = row => ({ id: row.id, roomId: row.room_id, authorId: row.author_id, channel: row.channel, to: row.recipient,
  subject: row.subject, body: row.body, state: row.state, decidedBy: row.decided_by,
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });
function draft(ctx, roomId) {
  const row = ensureOutbound(ctx.store.db).prepare("SELECT * FROM outbound_drafts WHERE room_id=? AND id=?").get(roomId, ctx.params.draftId);
  if (!row) ctx.reject(404, "draft_not_found", "No such draft in this room");
  return row;
}

export function readPolicy(ctx) {
  const { roomId, authority } = access(ctx, false);
  const db = ensureOutbound(ctx.store.db);
  const policies = Object.keys(authority.members ?? {}).filter(id => ownMember(authority.members, id)?.active !== false)
    .map(memberId => ({ memberId, allowSend: allowsSend(db, roomId, memberId) }));
  return ctx.json(ctx.res, 200, { roomId, policies });
}

export async function writePolicy(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner lets an agent send without a draft");
  const data = await ctx.body(ctx.req);
  if (typeof data?.requestId !== "string" || typeof data.agentId !== "string" || typeof data.allowSend !== "boolean") ctx.reject(422, "invalid_outbound_policy", "Supply requestId, agentId and allowSend");
  if (!ownMember(authority.members, data.agentId)) ctx.reject(404, "member_not_found", "No such member in this room");
  ensureOutbound(ctx.store.db).prepare(`INSERT INTO outbound_policies(room_id,member_id,allow_send,updated_by,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(room_id,member_id) DO UPDATE SET allow_send=excluded.allow_send, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(roomId, data.agentId, data.allowSend ? 1 : 0, auth.member.id, ctx.store.now());
  return ctx.json(ctx.res, 200, { roomId, memberId: data.agentId, allowSend: data.allowSend });
}

export async function submitOutbound(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  const ok = typeof data?.requestId === "string" && data.requestId && data.requestId.length <= 128 && OUTBOUND_CHANNELS.includes(data.channel)
    && typeof data.to === "string" && data.to.trim() && data.to.length <= 320 && typeof data.body === "string" && data.body.trim() && data.body.length <= 20000
    && (data.subject == null || (typeof data.subject === "string" && data.subject.length <= 300));
  if (!ok) ctx.reject(422, "invalid_outbound", `Supply requestId, channel (${OUTBOUND_CHANNELS.join(", ")}), to, body and an optional subject`);
  const db = ensureOutbound(ctx.store.db);
  if (allowsSend(db, roomId, auth.member.id)) return ctx.json(ctx.res, 200, { roomId, mode: "send", draft: null });
  const prior = db.prepare("SELECT * FROM outbound_drafts WHERE room_id=? AND author_id=? AND request_id=?").get(roomId, auth.member.id, data.requestId);
  if (prior) return ctx.json(ctx.res, 200, { roomId, mode: "draft", draft: view(prior) });
  const now = ctx.store.now(), id = `drf_${randomUUID()}`;
  db.prepare("INSERT INTO outbound_drafts(id,room_id,author_id,request_id,channel,recipient,subject,body,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?)")
    .run(id, roomId, auth.member.id, data.requestId, data.channel, data.to.trim(), data.subject ?? null, data.body, now, now);
  return ctx.json(ctx.res, 201, { roomId, mode: "draft", draft: view(db.prepare("SELECT * FROM outbound_drafts WHERE id=?").get(id)) });
}

export function listOutbound(ctx) {
  const { roomId } = access(ctx, false);
  const state = ctx.url.searchParams.get("state");
  if (state !== null && !STATES.includes(state)) ctx.reject(422, "invalid_draft_state", `state is one of ${STATES.join(", ")}`);
  const db = ensureOutbound(ctx.store.db);
  const rows = state ? db.prepare("SELECT * FROM outbound_drafts WHERE room_id=? AND state=? ORDER BY created_at DESC LIMIT 100").all(roomId, state)
    : db.prepare("SELECT * FROM outbound_drafts WHERE room_id=? ORDER BY created_at DESC LIMIT 100").all(roomId);
  return ctx.json(ctx.res, 200, { roomId, drafts: rows.map(view) });
}

export async function decideOutbound(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner approves or discards a draft");
  const data = await ctx.body(ctx.req);
  if (!["approve", "discard"].includes(data?.decision) || (data.body != null && (typeof data.body !== "string" || !data.body.trim() || data.body.length > 20000)))
    ctx.reject(422, "invalid_decision", "decision is approve or discard; body optionally replaces the text");
  const row = draft(ctx, roomId);
  if (row.state !== "draft") ctx.reject(409, "draft_already_decided", `This draft is already ${row.state}`);
  ctx.store.db.prepare("UPDATE outbound_drafts SET state=?, body=?, decided_by=?, updated_at=? WHERE id=?")
    .run(data.decision === "approve" ? "approved" : "discarded", data.body ?? row.body, auth.member.id, ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(draft(ctx, roomId)));
}

export function markSent(ctx) {
  const { roomId, auth } = access(ctx, true);
  const row = draft(ctx, roomId);
  if (row.author_id !== auth.member.id) ctx.reject(403, "author_required", "Only the draft's author records it sent");
  if (row.state === "sent") return ctx.json(ctx.res, 200, view(row));
  if (row.state !== "approved") ctx.reject(409, "draft_not_approved", `This draft is ${row.state}; the owner approves it first`);
  ctx.store.db.prepare("UPDATE outbound_drafts SET state='sent', updated_at=? WHERE id=?").run(ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(draft(ctx, roomId)));
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const draftParams = Object.freeze({ type: "object", required: ["roomId", "draftId"], properties: { roomId: { type: "string" }, draftId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; an MCP tool rides the lean tool list once #4339 lands";
const row = (id, method, path, handler, p) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const OUTBOUND_ROUTES = Object.freeze([
  row("outbound-policy-read", "GET", "/api/rooms/{roomId}/outbound-policy", readPolicy, params),
  row("outbound-policy-write", "PUT", "/api/rooms/{roomId}/outbound-policy", writePolicy, params),
  row("outbound-submit", "POST", "/api/rooms/{roomId}/outbound", submitOutbound, params),
  row("outbound-list", "GET", "/api/rooms/{roomId}/outbound", listOutbound, params),
  row("outbound-decide", "POST", "/api/rooms/{roomId}/outbound/{draftId}/decision", decideOutbound, draftParams),
  row("outbound-sent", "POST", "/api/rooms/{roomId}/outbound/{draftId}/sent", markSent, draftParams),
]);
