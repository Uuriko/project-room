// Team routines (Town-style "update once, every Townie adopts it").
// A routine blueprint is a named, scheduled procedure any member can post.
// Members install it for themselves; the room owner can install it as the
// room (a shared routine that runs once for everyone). Editing a blueprint
// bumps its version, and every install shows updateAvailable until it is
// reinstalled, so one fix reaches the whole team.
//
// GET  /api/rooms/{roomId}/routine-blueprints                 blueprints with install counts
// POST /api/rooms/{roomId}/routine-blueprints                 { requestId, name, schedule, steps } any member
// PUT  /api/rooms/{roomId}/routine-blueprints/{blueprintId}   { name?, schedule?, steps? } author or owner; version+1
// POST /api/rooms/{roomId}/routine-blueprints/{blueprintId}/install  { as: "me" | "room" }
// GET  /api/rooms/{roomId}/routines                           the caller's installs plus the room's
import { randomUUID } from "node:crypto";

// "daily 09:00", "weekdays 08:30", "weekly mon 09:00", "every 2h", "every 30m".
export const SCHEDULE = /^(daily \d{2}:\d{2}|weekdays \d{2}:\d{2}|weekly (mon|tue|wed|thu|fri|sat|sun) \d{2}:\d{2}|every ([1-9]\d?)(m|h))$/;
const SCHEMA = `CREATE TABLE IF NOT EXISTS routine_blueprints (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_id TEXT NOT NULL, request_id TEXT NOT NULL, name TEXT NOT NULL,
  schedule TEXT NOT NULL, steps TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(room_id, author_id, request_id));
CREATE TABLE IF NOT EXISTS routine_installs (
  blueprint_id TEXT NOT NULL, room_id TEXT NOT NULL, installed_for TEXT NOT NULL, version INTEGER NOT NULL, installed_at INTEGER NOT NULL,
  PRIMARY KEY(blueprint_id, installed_for))`;
const ready = new WeakSet();
export function ensureRoutines(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }
export const ROOM_INSTALL = "@room";

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

function fields(ctx, data, partial) {
  const out = {};
  for (const [key, ok] of [["name", v => typeof v === "string" && v.trim() && v.length <= 80], ["schedule", v => typeof v === "string" && SCHEDULE.test(v)],
    ["steps", v => typeof v === "string" && v.trim() && v.length <= 4000]]) {
    if (data?.[key] === undefined && partial) continue;
    if (!ok(data?.[key])) ctx.reject(422, "invalid_routine", "name (at most 80), schedule (daily 09:00, weekdays 08:30, weekly mon 09:00, every 2h) and steps (at most 4000)");
    out[key] = data[key].trim();
  }
  return out;
}
const view = (db, row) => ({ id: row.id, authorId: row.author_id, name: row.name, schedule: row.schedule, steps: row.steps, version: row.version,
  installs: db.prepare("SELECT COUNT(*) AS n FROM routine_installs WHERE blueprint_id=?").get(row.id).n, updatedAt: new Date(row.updated_at).toISOString() });
function blueprint(ctx, roomId) {
  const row = ensureRoutines(ctx.store.db).prepare("SELECT * FROM routine_blueprints WHERE room_id=? AND id=?").get(roomId, ctx.params.blueprintId);
  if (!row) ctx.reject(404, "routine_not_found", "No such routine blueprint in this room");
  return row;
}

export function listBlueprints(ctx) {
  const { roomId } = access(ctx, false);
  const db = ensureRoutines(ctx.store.db);
  return ctx.json(ctx.res, 200, { roomId, blueprints: db.prepare("SELECT * FROM routine_blueprints WHERE room_id=? ORDER BY created_at").all(roomId).map(row => view(db, row)) });
}

export async function createBlueprint(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  if (typeof data?.requestId !== "string" || !data.requestId || data.requestId.length > 128) ctx.reject(422, "invalid_routine", "Supply requestId");
  const f = fields(ctx, data, false);
  const db = ensureRoutines(ctx.store.db);
  const prior = db.prepare("SELECT * FROM routine_blueprints WHERE room_id=? AND author_id=? AND request_id=?").get(roomId, auth.member.id, data.requestId);
  if (prior) return ctx.json(ctx.res, 200, view(db, prior));
  const now = ctx.store.now(), id = `rtn_${randomUUID()}`;
  db.prepare("INSERT INTO routine_blueprints VALUES(?,?,?,?,?,?,?,1,?,?)").run(id, roomId, auth.member.id, data.requestId, f.name, f.schedule, f.steps, now, now);
  return ctx.json(ctx.res, 201, view(db, db.prepare("SELECT * FROM routine_blueprints WHERE id=?").get(id)));
}

export async function editBlueprint(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  const row = blueprint(ctx, roomId);
  if (row.author_id !== auth.member.id && authority.ownerId !== auth.member.id) ctx.reject(403, "author_required", "Only the author or the room owner edits a blueprint");
  const f = fields(ctx, await ctx.body(ctx.req), true);
  if (Object.keys(f).length === 0) ctx.reject(422, "invalid_routine", "Change at least one of name, schedule, steps");
  ctx.store.db.prepare("UPDATE routine_blueprints SET name=?, schedule=?, steps=?, version=version+1, updated_at=? WHERE id=?")
    .run(f.name ?? row.name, f.schedule ?? row.schedule, f.steps ?? row.steps, ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(ctx.store.db, blueprint(ctx, roomId)));
}

export async function installBlueprint(ctx) {
  const { roomId, auth, authority } = access(ctx, true);
  const row = blueprint(ctx, roomId);
  const data = await ctx.body(ctx.req);
  if (!["me", "room"].includes(data?.as)) ctx.reject(422, "invalid_install", "as is me or room");
  if (data.as === "room" && authority.ownerId !== auth.member.id) ctx.reject(403, "owner_required", "Only the room owner installs a routine as the room");
  const target = data.as === "room" ? ROOM_INSTALL : auth.member.id;
  ctx.store.db.prepare(`INSERT INTO routine_installs VALUES(?,?,?,?,?) ON CONFLICT(blueprint_id, installed_for) DO UPDATE SET version=excluded.version, installed_at=excluded.installed_at`)
    .run(row.id, roomId, target, row.version, ctx.store.now());
  return ctx.json(ctx.res, 200, { roomId, blueprintId: row.id, installedFor: target, version: row.version });
}

export function myRoutines(ctx) {
  const { roomId, auth } = access(ctx, false);
  const rows = ensureRoutines(ctx.store.db).prepare(`SELECT b.*, i.installed_for, i.version AS installed_version FROM routine_installs i JOIN routine_blueprints b ON b.id=i.blueprint_id
    WHERE i.room_id=? AND i.installed_for IN (?, ?) ORDER BY b.name`).all(roomId, auth.member.id, ROOM_INSTALL);
  return ctx.json(ctx.res, 200, { roomId, routines: rows.map(row => ({ blueprintId: row.id, name: row.name, schedule: row.schedule, steps: row.steps,
    runsAs: row.installed_for === ROOM_INSTALL ? "room" : "me", installedVersion: row.installed_version, version: row.version, updateAvailable: row.version > row.installed_version })) });
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const idParams = Object.freeze({ type: "object", required: ["roomId", "blueprintId"], properties: { roomId: { type: "string" }, blueprintId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; the agent's own loop runs installed routines (room wake-me), an MCP tool follows #4339";
const row = (id, method, path, handler, p) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const ROUTINE_ROUTES = Object.freeze([
  row("routine-blueprints-list", "GET", "/api/rooms/{roomId}/routine-blueprints", listBlueprints, params),
  row("routine-blueprints-create", "POST", "/api/rooms/{roomId}/routine-blueprints", createBlueprint, params),
  row("routine-blueprints-edit", "PUT", "/api/rooms/{roomId}/routine-blueprints/{blueprintId}", editBlueprint, idParams),
  row("routine-blueprints-install", "POST", "/api/rooms/{roomId}/routine-blueprints/{blueprintId}/install", installBlueprint, idParams),
  row("routines-mine", "GET", "/api/rooms/{roomId}/routines", myRoutines, params),
]);
