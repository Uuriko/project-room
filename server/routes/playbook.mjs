// Shared playbook (Town-style "update once, apply everywhere").
// One pinned procedure per room, versioned. Every edit keeps the old text and
// a one-line changelog note, so agents that load it on wake can tell what
// changed since the version they last followed.
//
// GET /api/rooms/{roomId}/playbook[?since=N]  latest { version, body, note, editedBy, editedAt } plus the
//                                            changelog lines newer than N (all of them without since)
// GET /api/rooms/{roomId}/playbook/versions/{version}  one past version in full
// PUT /api/rooms/{roomId}/playbook            { requestId, body, note, baseVersion } owner or manage_members;
//                                            baseVersion must be the current version (409 otherwise)
import { ownMember } from "../../src/events.js";
const SCHEMA = `CREATE TABLE IF NOT EXISTS room_playbooks (
  room_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, note TEXT NOT NULL,
  edited_by TEXT NOT NULL, request_id TEXT NOT NULL, edited_at INTEGER NOT NULL, PRIMARY KEY(room_id, version))`;
const ready = new WeakSet();
export function ensurePlaybooks(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }
export const PLAYBOOK_MAX_CHARS = 20000;

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

const view = row => ({ version: row.version, body: row.body, note: row.note, editedBy: row.edited_by, editedAt: new Date(row.edited_at).toISOString() });
const line = row => ({ version: row.version, note: row.note, editedBy: row.edited_by, editedAt: new Date(row.edited_at).toISOString() });

export function latestPlaybook(db, roomId) {
  const row = ensurePlaybooks(db).prepare("SELECT * FROM room_playbooks WHERE room_id=? ORDER BY version DESC LIMIT 1").get(roomId);
  return row ? view(row) : null;
}

export function readPlaybook(ctx) {
  const { roomId } = access(ctx, false);
  const sinceText = ctx.url.searchParams.get("since");
  if (sinceText !== null && !/^\d{1,9}$/.test(sinceText)) ctx.reject(422, "invalid_since", "since is a version number");
  const since = sinceText === null ? 0 : Number(sinceText);
  const db = ensurePlaybooks(ctx.store.db);
  const changelog = db.prepare("SELECT version,note,edited_by,edited_at FROM room_playbooks WHERE room_id=? AND version>? ORDER BY version DESC LIMIT 50").all(roomId, since).map(line);
  return ctx.json(ctx.res, 200, { roomId, playbook: latestPlaybook(db, roomId), changed: changelog.length > 0, changelog });
}

export function readPlaybookVersion(ctx) {
  const { roomId } = access(ctx, false);
  const version = Number(ctx.params.version);
  const row = Number.isSafeInteger(version) && ensurePlaybooks(ctx.store.db).prepare("SELECT * FROM room_playbooks WHERE room_id=? AND version=?").get(roomId, version);
  if (!row) ctx.reject(404, "playbook_version_not_found", "No such playbook version");
  return ctx.json(ctx.res, 200, { roomId, playbook: view(row) });
}

export async function writePlaybook(ctx) {
  const { roomId, auth } = access(ctx, true);
  const authority = ctx.store.roomAuthority(roomId);
  const permissions = ownMember(authority.members, auth.member.id)?.permissions ?? auth.member.permissions ?? [];
  if (authority.ownerId !== auth.member.id && !permissions.includes("manage_members")) ctx.reject(403, "owner_required", "Only the room owner or an admin edits the playbook");
  const data = await ctx.body(ctx.req);
  const body = typeof data?.body === "string" ? data.body.trim() : "";
  const note = typeof data?.note === "string" ? data.note.trim() : "";
  if (typeof data?.requestId !== "string" || !data.requestId || !body || body.length > PLAYBOOK_MAX_CHARS || !note || note.length > 200 || !Number.isSafeInteger(data.baseVersion) || data.baseVersion < 0)
    ctx.reject(422, "invalid_playbook", `Supply requestId, body (at most ${PLAYBOOK_MAX_CHARS} characters), a one-line note (at most 200) and baseVersion`);
  const db = ensurePlaybooks(ctx.store.db);
  const retry = db.prepare("SELECT * FROM room_playbooks WHERE room_id=? AND edited_by=? AND request_id=?").get(roomId, auth.member.id, data.requestId);
  if (retry) return ctx.json(ctx.res, 200, { roomId, playbook: view(retry) });
  const current = latestPlaybook(db, roomId)?.version ?? 0;
  if (data.baseVersion !== current) ctx.reject(409, "playbook_version_conflict", `The playbook is at version ${current}; reload it and edit from there`);
  db.prepare("INSERT INTO room_playbooks(room_id,version,body,note,edited_by,request_id,edited_at) VALUES(?,?,?,?,?,?,?)")
    .run(roomId, current + 1, body, note, auth.member.id, data.requestId, ctx.store.now());
  return ctx.json(ctx.res, 201, { roomId, playbook: latestPlaybook(db, roomId) });
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const versionParams = Object.freeze({ type: "object", required: ["roomId", "version"], properties: { roomId: { type: "string" }, version: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; the wake payload and an MCP tool follow once #4339 lands";
const row = (id, method, path, handler, p) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const PLAYBOOK_ROUTES = Object.freeze([
  row("playbook-read", "GET", "/api/rooms/{roomId}/playbook", readPlaybook, params),
  row("playbook-write", "PUT", "/api/rooms/{roomId}/playbook", writePlaybook, params),
  row("playbook-version", "GET", "/api/rooms/{roomId}/playbook/versions/{version}", readPlaybookVersion, versionParams),
]);
