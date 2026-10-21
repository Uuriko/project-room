// Permission modes: how much an agent may do in this room without asking.
//
// GET  /api/rooms/{roomId}/permission-modes        every member's mode (default ask)
// PUT  /api/rooms/{roomId}/permission-modes        { requestId, agentId, mode } room owner only
// POST /api/rooms/{roomId}/permission-modes/check  { action } -> { decision: allow|ask }; on ask the
//                                                  agent posts an approval card (#4371) instead of acting
import { ownMember } from "../../src/events.js";
import { DEFAULT_MODE, PERMISSION_MODES, SAFE_ACTIONS, decide } from "../../src/permission-modes.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS permission_modes (
  room_id TEXT NOT NULL, member_id TEXT NOT NULL, mode TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, member_id))`;
const ready = new WeakSet();
export function ensurePermissionModes(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

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

export function modeOf(db, roomId, memberId) {
  return ensurePermissionModes(db).prepare("SELECT mode FROM permission_modes WHERE room_id=? AND member_id=?").get(roomId, memberId)?.mode ?? DEFAULT_MODE;
}

export function readModes(ctx) {
  const { roomId, authority } = access(ctx, false);
  const modes = Object.keys(authority.members ?? {}).filter(id => ownMember(authority.members, id)?.active !== false)
    .map(memberId => ({ memberId, mode: modeOf(ctx.store.db, roomId, memberId) }));
  return ctx.json(ctx.res, 200, { roomId, modes, safeActions: SAFE_ACTIONS });
}

export async function writeMode(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner sets an agent's permission mode");
  const data = await ctx.body(ctx.req);
  if (typeof data?.requestId !== "string" || typeof data.agentId !== "string" || !PERMISSION_MODES.includes(data.mode))
    ctx.reject(422, "invalid_permission_mode", "Supply requestId, agentId and mode (ask, safe or all)");
  if (!ownMember(authority.members, data.agentId)) ctx.reject(404, "member_not_found", "No such member in this room");
  ensurePermissionModes(ctx.store.db).prepare(`INSERT INTO permission_modes(room_id,member_id,mode,updated_by,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(room_id,member_id) DO UPDATE SET mode=excluded.mode, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(roomId, data.agentId, data.mode, auth.member.id, ctx.store.now());
  return ctx.json(ctx.res, 200, { roomId, memberId: data.agentId, mode: data.mode });
}

export async function checkMode(ctx) {
  const { roomId, auth, authority } = access(ctx, false);
  const data = await ctx.body(ctx.req);
  // The room owner never needs its own approval.
  const mode = authority.ownerId === auth.member.id ? "all" : modeOf(ctx.store.db, roomId, auth.member.id);
  const decision = decide(mode, data?.action);
  if (!decision) ctx.reject(422, "invalid_action", "action is a short lowercase name such as post_message or merge_pr");
  return ctx.json(ctx.res, 200, { roomId, memberId: auth.member.id, mode, action: data.action, decision,
    next: decision === "ask" ? { method: "POST", path: `/api/rooms/${encodeURIComponent(roomId)}/approvals` } : null });
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; an MCP tool rides the lean tool list once #4339 lands";
const row = (id, method, path, handler) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params, response }, events: [] });
export const PERMISSION_MODE_ROUTES = Object.freeze([
  row("permission-modes-read", "GET", "/api/rooms/{roomId}/permission-modes", readModes),
  row("permission-modes-write", "PUT", "/api/rooms/{roomId}/permission-modes", writeMode),
  row("permission-modes-check", "POST", "/api/rooms/{roomId}/permission-modes/check", checkMode),
]);
