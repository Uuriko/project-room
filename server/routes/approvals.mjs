// Approve, then act (Town-style one-tap approval).
// A member posts a request as an approval card; the room owner approves or
// denies it; on approve, the named agent (the requester by default) picks it
// up from its ready list on the next wake, carries it out, and reports back.
//
// POST /api/rooms/{roomId}/approvals                  { requestId, summary, action?, executorId? } -> pending card
// GET  /api/rooms/{roomId}/approvals[?state=pending]   cards in this room, newest first
// GET  /api/rooms/{roomId}/approvals/ready             approved cards the caller should carry out now
// POST /api/rooms/{roomId}/approvals/{approvalId}/decision  { decision: approve|deny, note? } owner only
// POST /api/rooms/{roomId}/approvals/{approvalId}/done      { ok, result? } executor only
import { ownMember } from "../../src/events.js";
import { randomUUID } from "node:crypto";

export const APPROVAL_STATES = Object.freeze(["pending", "approved", "denied", "done", "failed"]);
const SCHEMA = `CREATE TABLE IF NOT EXISTS approval_cards (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, requested_by TEXT NOT NULL, request_id TEXT NOT NULL,
  executor_id TEXT NOT NULL, summary TEXT NOT NULL, action TEXT, state TEXT NOT NULL,
  decided_by TEXT, note TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(room_id, requested_by, request_id))`;
const ready = new WeakSet();
export function ensureApprovals(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

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

const view = row => row && ({ id: row.id, roomId: row.room_id, requestedBy: row.requested_by, executorId: row.executor_id,
  summary: row.summary, action: row.action ? JSON.parse(row.action) : null, state: row.state, decidedBy: row.decided_by,
  note: row.note, result: row.result, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });

function card(ctx, roomId) {
  const row = ensureApprovals(ctx.store.db).prepare("SELECT * FROM approval_cards WHERE room_id=? AND id=?").get(roomId, ctx.params.approvalId);
  if (!row) ctx.reject(404, "approval_not_found", "No such approval card in this room");
  return row;
}

export function pendingApprovals(db, roomId) {
  return ensureApprovals(db).prepare("SELECT * FROM approval_cards WHERE room_id=? AND state='pending' ORDER BY created_at DESC LIMIT 50").all(roomId).map(view);
}

export async function createApproval(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  const summary = typeof data?.summary === "string" ? data.summary.trim() : "";
  if (typeof data?.requestId !== "string" || !data.requestId || data.requestId.length > 128 || !summary || summary.length > 500)
    ctx.reject(422, "invalid_approval", "Supply requestId and a summary of at most 500 characters");
  const action = data.action === undefined || data.action === null ? null : JSON.stringify(data.action);
  if (action !== null && (typeof data.action !== "object" || action.length > 4096)) ctx.reject(422, "invalid_approval", "action is an object of at most 4 KB");
  const executorId = data.executorId ?? auth.member.id;
  if (typeof executorId !== "string" || !ownMember(authority.members, executorId)) ctx.reject(404, "member_not_found", "executorId is not a member of this room");
  const db = ensureApprovals(ctx.store.db);
  const prior = db.prepare("SELECT * FROM approval_cards WHERE room_id=? AND requested_by=? AND request_id=?").get(roomId, auth.member.id, data.requestId);
  if (prior) return ctx.json(ctx.res, 200, view(prior));
  const now = ctx.store.now(), id = `apv_${randomUUID()}`;
  db.prepare("INSERT INTO approval_cards(id,room_id,requested_by,request_id,executor_id,summary,action,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)")
    .run(id, roomId, auth.member.id, data.requestId, executorId, summary, action, now, now);
  return ctx.json(ctx.res, 201, view(db.prepare("SELECT * FROM approval_cards WHERE id=?").get(id)));
}

export function listApprovals(ctx) {
  const { roomId } = access(ctx, false);
  const state = ctx.url.searchParams.get("state");
  if (state !== null && !APPROVAL_STATES.includes(state)) ctx.reject(422, "invalid_approval_state", `state is one of ${APPROVAL_STATES.join(", ")}`);
  const db = ensureApprovals(ctx.store.db);
  const rows = state ? db.prepare("SELECT * FROM approval_cards WHERE room_id=? AND state=? ORDER BY created_at DESC LIMIT 100").all(roomId, state)
    : db.prepare("SELECT * FROM approval_cards WHERE room_id=? ORDER BY created_at DESC LIMIT 100").all(roomId);
  return ctx.json(ctx.res, 200, { roomId, approvals: rows.map(view) });
}

export function readyApprovals(ctx) {
  const { roomId, auth } = access(ctx, false);
  const rows = ensureApprovals(ctx.store.db).prepare("SELECT * FROM approval_cards WHERE room_id=? AND executor_id=? AND state='approved' ORDER BY updated_at").all(roomId, auth.member.id);
  return ctx.json(ctx.res, 200, { roomId, memberId: auth.member.id, ready: rows.map(view) });
}

export async function decideApproval(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner approves or denies");
  const data = await ctx.body(ctx.req);
  if (!["approve", "deny"].includes(data?.decision) || (data.note != null && (typeof data.note !== "string" || data.note.length > 500)))
    ctx.reject(422, "invalid_decision", "decision is approve or deny; note is at most 500 characters");
  const row = card(ctx, roomId);
  const state = data.decision === "approve" ? "approved" : "denied";
  if (row.state !== "pending") {
    if (row.state === state) return ctx.json(ctx.res, 200, view(row));
    ctx.reject(409, "approval_already_decided", `This card is already ${row.state}`);
  }
  ctx.store.db.prepare("UPDATE approval_cards SET state=?, decided_by=?, note=?, updated_at=? WHERE id=?").run(state, auth.member.id, data.note ?? null, ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(card(ctx, roomId)));
}

export async function finishApproval(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  if (typeof data?.ok !== "boolean" || (data.result != null && (typeof data.result !== "string" || data.result.length > 2000)))
    ctx.reject(422, "invalid_approval_result", "Supply ok (true or false) and an optional result of at most 2000 characters");
  const row = card(ctx, roomId);
  if (row.executor_id !== auth.member.id) ctx.reject(403, "executor_required", "Only the agent named on the card reports its result");
  if (row.state !== "approved") ctx.reject(409, "approval_not_approved", `This card is ${row.state}, not approved`);
  ctx.store.db.prepare("UPDATE approval_cards SET state=?, result=?, updated_at=? WHERE id=?").run(data.ok ? "done" : "failed", data.result ?? null, ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(card(ctx, roomId)));
}

const roomParams = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const cardParams = Object.freeze({ type: "object", required: ["roomId", "approvalId"], properties: { roomId: { type: "string" }, approvalId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; an MCP tool rides the lean tool list once #4339 lands";
const row = (id, method, path, handler, params) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params, response }, events: [] });
export const APPROVAL_ROUTES = Object.freeze([
  row("approvals-create", "POST", "/api/rooms/{roomId}/approvals", createApproval, roomParams),
  row("approvals-list", "GET", "/api/rooms/{roomId}/approvals", listApprovals, roomParams),
  row("approvals-ready", "GET", "/api/rooms/{roomId}/approvals/ready", readyApprovals, roomParams),
  row("approvals-decide", "POST", "/api/rooms/{roomId}/approvals/{approvalId}/decision", decideApproval, cardParams),
  row("approvals-done", "POST", "/api/rooms/{roomId}/approvals/{approvalId}/done", finishApproval, cardParams),
]);
