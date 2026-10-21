// Sharing limits: what of its owner's information each agent may share here.
//
// GET  /api/rooms/{roomId}/sharing-limits        every member's limit (defaults to code only)
// PUT  /api/rooms/{roomId}/sharing-limits        { requestId, share, agentId? } the caller sets its own;
//                                                the room owner may set any member's
// POST /api/rooms/{roomId}/sharing-limits/check  { kinds, what? } inside the caller's limit, or the ask to raise
import { ownMember } from "../../src/events.js";
import { DEFAULT_SHARE, checkShare, normalizeShare } from "../../src/sharing-limits.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS sharing_limits (
  room_id TEXT NOT NULL, member_id TEXT NOT NULL, share TEXT NOT NULL,
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(room_id, member_id))`;
const ready = new WeakSet();
export function ensureSharingLimits(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

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
  return { roomId, auth };
}

export function shareOf(db, roomId, memberId) {
  const row = ensureSharingLimits(db).prepare("SELECT share FROM sharing_limits WHERE room_id=? AND member_id=?").get(roomId, memberId);
  return row ? JSON.parse(row.share) : [...DEFAULT_SHARE];
}

export function readSharingLimits(ctx) {
  const { roomId } = access(ctx, false);
  const { members } = ctx.store.roomAuthority(roomId);
  const limits = Object.keys(members ?? {}).filter(id => ownMember(members, id)?.active !== false)
    .map(memberId => ({ memberId, share: shareOf(ctx.store.db, roomId, memberId) }));
  return ctx.json(ctx.res, 200, { roomId, limits });
}

export async function writeSharingLimits(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  const share = normalizeShare(data?.share);
  if (!data || typeof data.requestId !== "string" || !share) ctx.reject(422, "invalid_sharing_limits", "Supply requestId and share, a list of kinds such as code, calendar, email");
  const authority = ctx.store.roomAuthority(roomId);
  const target = data.agentId ?? auth.member.id;
  if (typeof target !== "string" || !ownMember(authority.members, target)) ctx.reject(404, "member_not_found", "No such member in this room");
  if (target !== auth.member.id && authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner sets another member's sharing limit");
  ensureSharingLimits(ctx.store.db).prepare(`INSERT INTO sharing_limits(room_id,member_id,share,updated_by,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(room_id,member_id) DO UPDATE SET share=excluded.share, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .run(roomId, target, JSON.stringify(share), auth.member.id, ctx.store.now());
  return ctx.json(ctx.res, 200, { roomId, memberId: target, share });
}

export async function checkSharingLimit(ctx) {
  const { roomId, auth } = access(ctx, false);
  const data = await ctx.body(ctx.req);
  const what = typeof data?.what === "string" ? data.what.slice(0, 120) : null;
  const result = checkShare(shareOf(ctx.store.db, roomId, auth.member.id), data?.kinds, { agentName: auth.member.displayName ?? auth.member.id, what });
  if (!result) ctx.reject(422, "invalid_sharing_check", "kinds must be a non-empty list of known kinds");
  return ctx.json(ctx.res, 200, { roomId, memberId: auth.member.id, ...result });
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; an MCP tool rides the lean tool list once #4339 lands";
export const SHARING_LIMIT_ROUTES = Object.freeze([
  Object.freeze({ id: "sharing-limits-read", method: "GET", path: "/api/rooms/{roomId}/sharing-limits", auth: "room", capability: null, scope: "room",
    handler: readSharingLimits, parity, schema: { params, response }, events: [] }),
  Object.freeze({ id: "sharing-limits-write", method: "PUT", path: "/api/rooms/{roomId}/sharing-limits", auth: "room", capability: null, scope: "room",
    handler: writeSharingLimits, parity, schema: { params, response }, events: [] }),
  Object.freeze({ id: "sharing-limits-check", method: "POST", path: "/api/rooms/{roomId}/sharing-limits/check", auth: "room", capability: null, scope: "room",
    handler: checkSharingLimit, parity, schema: { params, response }, events: [] }),
]);
