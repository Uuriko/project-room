// Agent memory notes (Town-style "learns how you work").
// An agent keeps short notes about its owner's working style in a room
// ("prefers small PRs", "no emoji"). Only that agent and the room owner can
// read them, and the owner can edit or delete any note.
//
// GET    /api/rooms/{roomId}/agents/{agentId}/notes            the agent itself or the room owner
// POST   /api/rooms/{roomId}/agents/{agentId}/notes            { requestId, text }
// PUT    /api/rooms/{roomId}/agents/{agentId}/notes/{noteId}   { text }
// DELETE /api/rooms/{roomId}/agents/{agentId}/notes/{noteId}
import { randomUUID } from "node:crypto";
import { ownMember } from "../../src/events.js";

export const MAX_NOTES = 50, MAX_NOTE_CHARS = 500;
const SCHEMA = `CREATE TABLE IF NOT EXISTS agent_notes (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, text TEXT NOT NULL, author_id TEXT NOT NULL,
  request_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(room_id, agent_id, request_id))`;
const ready = new WeakSet();
export function ensureAgentNotes(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }

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

function scope(ctx, write) {
  const base = access(ctx, write);
  const agentId = ctx.params.agentId;
  if (!ownMember(base.authority.members, agentId)) ctx.reject(404, "member_not_found", "No such member in this room");
  // Private: the agent and the room owner only. Everyone else gets the same 404.
  if (base.auth.member.id !== agentId && base.authority.ownerId !== base.auth.member.id) ctx.reject(404, "member_not_found", "No such member in this room");
  return { ...base, agentId };
}
const view = row => ({ id: row.id, text: row.text, authorId: row.author_id, updatedAt: new Date(row.updated_at).toISOString() });
const list = (db, roomId, agentId) => ensureAgentNotes(db).prepare("SELECT * FROM agent_notes WHERE room_id=? AND agent_id=? ORDER BY created_at").all(roomId, agentId);
function text(ctx, value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > MAX_NOTE_CHARS) ctx.reject(422, "invalid_note", `text is 1 to ${MAX_NOTE_CHARS} characters`);
  return clean;
}
function note(ctx, roomId, agentId) {
  const row = ensureAgentNotes(ctx.store.db).prepare("SELECT * FROM agent_notes WHERE room_id=? AND agent_id=? AND id=?").get(roomId, agentId, ctx.params.noteId);
  if (!row) ctx.reject(404, "note_not_found", "No such note");
  return row;
}

export function readNotes(ctx) {
  const { roomId, agentId } = scope(ctx, false);
  return ctx.json(ctx.res, 200, { roomId, agentId, notes: list(ctx.store.db, roomId, agentId).map(view) });
}

export async function addNote(ctx) {
  const { roomId, agentId, auth } = scope(ctx, true);
  const data = await ctx.body(ctx.req);
  if (typeof data?.requestId !== "string" || !data.requestId || data.requestId.length > 128) ctx.reject(422, "invalid_note", "Supply requestId and text");
  const clean = text(ctx, data.text);
  const db = ensureAgentNotes(ctx.store.db);
  const prior = db.prepare("SELECT * FROM agent_notes WHERE room_id=? AND agent_id=? AND request_id=?").get(roomId, agentId, data.requestId);
  if (prior) return ctx.json(ctx.res, 200, view(prior));
  if (list(db, roomId, agentId).length >= MAX_NOTES) ctx.reject(409, "notes_full", `At most ${MAX_NOTES} notes; edit or delete one first`);
  const now = ctx.store.now(), id = `note_${randomUUID()}`;
  db.prepare("INSERT INTO agent_notes VALUES(?,?,?,?,?,?,?,?)").run(id, roomId, agentId, clean, auth.member.id, data.requestId, now, now);
  return ctx.json(ctx.res, 201, view(db.prepare("SELECT * FROM agent_notes WHERE id=?").get(id)));
}

export async function editNote(ctx) {
  const { roomId, agentId, auth } = scope(ctx, true);
  const row = note(ctx, roomId, agentId);
  const data = await ctx.body(ctx.req);
  ctx.store.db.prepare("UPDATE agent_notes SET text=?, author_id=?, updated_at=? WHERE id=?").run(text(ctx, data?.text), auth.member.id, ctx.store.now(), row.id);
  return ctx.json(ctx.res, 200, view(note(ctx, roomId, agentId)));
}

export function deleteNote(ctx) {
  const { roomId, agentId } = scope(ctx, true);
  const row = note(ctx, roomId, agentId);
  ctx.store.db.prepare("DELETE FROM agent_notes WHERE id=?").run(row.id);
  return ctx.json(ctx.res, 200, { roomId, agentId, id: row.id, deleted: true });
}

const params = Object.freeze({ type: "object", required: ["roomId", "agentId"], properties: { roomId: { type: "string" }, agentId: { type: "string" } } });
const noteParams = Object.freeze({ type: "object", required: ["roomId", "agentId", "noteId"], properties: { roomId: { type: "string" }, agentId: { type: "string" }, noteId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; an MCP tool rides the lean tool list once #4339 lands";
const row = (id, method, path, handler, p) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const AGENT_NOTE_ROUTES = Object.freeze([
  row("agent-notes-read", "GET", "/api/rooms/{roomId}/agents/{agentId}/notes", readNotes, params),
  row("agent-notes-add", "POST", "/api/rooms/{roomId}/agents/{agentId}/notes", addNote, params),
  row("agent-notes-edit", "PUT", "/api/rooms/{roomId}/agents/{agentId}/notes/{noteId}", editNote, noteParams),
  row("agent-notes-delete", "DELETE", "/api/rooms/{roomId}/agents/{agentId}/notes/{noteId}", deleteNote, noteParams),
]);
