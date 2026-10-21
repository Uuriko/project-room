// Shared team connections (Town-style "connect once, grant to the team").
// The room owner registers a service connection once and grants it to all
// members, chosen members, or automations only. Room stores only an opaque
// connection reference (conn_...), never a token: the credential stays in
// the server-side connector store that minted the reference.
//
// GET    /api/rooms/{roomId}/team-connections                 owner: all; others: the ones granted to them
// POST   /api/rooms/{roomId}/team-connections                 { requestId, service, label, connectionRef, scope, members? } owner only
// PUT    /api/rooms/{roomId}/team-connections/{connectionId}  { scope, members? } owner only
// DELETE /api/rooms/{roomId}/team-connections/{connectionId}  owner only
// GET    /api/rooms/{roomId}/team-connections/{connectionId}/access  may the caller use it now?
import { randomUUID } from "node:crypto";
import { ownMember } from "../../src/events.js";

export const CONNECTION_SCOPES = Object.freeze(["all", "members", "automations"]);
const REF = /^conn_[A-Za-z0-9_-]{6,64}$/;
const SERVICE = /^[a-z][a-z0-9-]{1,31}$/;
const SCHEMA = `CREATE TABLE IF NOT EXISTS team_connections (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, service TEXT NOT NULL, label TEXT NOT NULL, connection_ref TEXT NOT NULL,
  scope TEXT NOT NULL, members TEXT NOT NULL, created_by TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(room_id, created_by, request_id))`;
const ready = new WeakSet();
export function ensureTeamConnections(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

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

// connectionRef is shown to the owner only; members see service and label.
const view = (row, owner) => ({ id: row.id, service: row.service, label: row.label, scope: row.scope,
  members: row.scope === "members" ? JSON.parse(row.members) : [], ...(owner ? { connectionRef: row.connection_ref } : {}),
  updatedAt: new Date(row.updated_at).toISOString() });
export function mayUse(row, memberId, ownerId) {
  if (memberId === ownerId) return true;
  if (row.scope === "all") return true;
  if (row.scope === "members") return JSON.parse(row.members).includes(memberId);
  return false; // automations only: room routines, never a member directly
}
function grant(ctx, data, authority) {
  if (!CONNECTION_SCOPES.includes(data?.scope)) ctx.reject(422, "invalid_team_connection", "scope is all, members or automations");
  if (data.scope !== "members") return [];
  const list = data.members;
  if (!Array.isArray(list) || list.length === 0 || list.length > 50 || list.some(id => typeof id !== "string" || !ownMember(authority.members, id)))
    ctx.reject(422, "invalid_team_connection", "members is 1 to 50 member ids of this room");
  return [...new Set(list)];
}
function owned(ctx, auth, authority) {
  if (authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner manages team connections");
}
function find(ctx, roomId) {
  const row = ensureTeamConnections(ctx.store.db).prepare("SELECT * FROM team_connections WHERE room_id=? AND id=?").get(roomId, ctx.params.connectionId);
  if (!row) ctx.reject(404, "team_connection_not_found", "No such team connection in this room");
  return row;
}

export function listConnections(ctx) {
  const { roomId, auth, authority } = access(ctx, false);
  const owner = authority.ownerId === auth.member.id;
  const rows = ensureTeamConnections(ctx.store.db).prepare("SELECT * FROM team_connections WHERE room_id=? ORDER BY created_at").all(roomId);
  return ctx.json(ctx.res, 200, { roomId, connections: rows.filter(row => mayUse(row, auth.member.id, authority.ownerId)).map(row => view(row, owner)) });
}

export async function createConnection(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  owned(ctx, auth, authority);
  const data = await ctx.body(ctx.req);
  const label = typeof data?.label === "string" ? data.label.trim() : "";
  if (typeof data?.requestId !== "string" || !data.requestId || !SERVICE.test(data.service ?? "") || !label || label.length > 80 || !REF.test(data.connectionRef ?? ""))
    ctx.reject(422, "invalid_team_connection", "Supply requestId, service (e.g. github), label and connectionRef (conn_...); never a token");
  const members = grant(ctx, data, authority);
  const db = ensureTeamConnections(ctx.store.db);
  const prior = db.prepare("SELECT * FROM team_connections WHERE room_id=? AND created_by=? AND request_id=?").get(roomId, auth.member.id, data.requestId);
  if (prior) return ctx.json(ctx.res, 200, view(prior, true));
  const now = ctx.store.now(), id = `tcn_${randomUUID()}`;
  db.prepare("INSERT INTO team_connections VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, roomId, data.service, label, data.connectionRef, data.scope, JSON.stringify(members), auth.member.id, data.requestId, now, now);
  return ctx.json(ctx.res, 201, view(db.prepare("SELECT * FROM team_connections WHERE id=?").get(id), true));
}

export async function updateConnection(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  owned(ctx, auth, authority);
  const row = find(ctx, roomId);
  const data = await ctx.body(ctx.req);
  const members = grant(ctx, data, authority);
  ctx.store.db.prepare("UPDATE team_connections SET scope=?, members=?, updated_at=? WHERE id=?").run(data.scope, JSON.stringify(members), ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(find(ctx, roomId), true));
}

export function deleteConnection(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  owned(ctx, auth, authority);
  const row = find(ctx, roomId);
  ctx.store.db.prepare("DELETE FROM team_connections WHERE id=?").run(row.id);
  return ctx.json(ctx.res, 200, { roomId, id: row.id, deleted: true });
}

export function connectionAccess(ctx) {
  const { roomId, auth, authority } = access(ctx, false);
  const row = find(ctx, roomId);
  const allowed = mayUse(row, auth.member.id, authority.ownerId);
  return ctx.json(ctx.res, 200, { roomId, id: row.id, service: row.service, allowed,
    reason: allowed ? null : row.scope === "automations" ? "automations_only" : "not_granted" });
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const idParams = Object.freeze({ type: "object", required: ["roomId", "connectionId"], properties: { roomId: { type: "string" }, connectionId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:owner management surface; the connector door consults access before it lends a credential";
const row = (id, method, path, handler, p) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const TEAM_CONNECTION_ROUTES = Object.freeze([
  row("team-connections-list", "GET", "/api/rooms/{roomId}/team-connections", listConnections, params),
  row("team-connections-create", "POST", "/api/rooms/{roomId}/team-connections", createConnection, params),
  row("team-connections-update", "PUT", "/api/rooms/{roomId}/team-connections/{connectionId}", updateConnection, idParams),
  row("team-connections-delete", "DELETE", "/api/rooms/{roomId}/team-connections/{connectionId}", deleteConnection, idParams),
  row("team-connections-access", "GET", "/api/rooms/{roomId}/team-connections/{connectionId}/access", connectionAccess, idParams),
]);
