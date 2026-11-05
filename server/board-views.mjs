// Board saved views (Linear parity: custom views / saved filters). OFF unless
// ROOM_BOARD_VIEWS=1. A view is a named, room-shared Board list query
// (state, queue, view and the #5889 planning filters and sort). Read it back
// with GET …/work-claims?savedView=<viewId>; explicit query params win over
// the saved ones. Any room member may save a view; its creator or the room
// owner may delete it.
import { randomUUID } from "node:crypto";

export const BOARD_VIEW_TABLES = Object.freeze(["room_board_views"]);
export const VIEW_QUERY_KEYS = Object.freeze(["state", "queue", "view", "priority", "cycleId", "milestone", "dueBefore", "sort", "projectId", "initiativeId", "groupBy"]);
export const boardViewsEnabled = (env = process.env) => env?.ROOM_BOARD_VIEWS === "1";
const ensure = db => db.exec(`CREATE TABLE IF NOT EXISTS room_board_views (view_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
  name TEXT NOT NULL, query_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);

// Only Board list keys are kept, as strings; the list route validates values.
export function viewQueryOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!VIEW_QUERY_KEYS.includes(key)) return null;
    if (typeof value !== "string" && typeof value !== "number") return null;
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

const row = r => ({ viewId: r.view_id, name: r.name, query: JSON.parse(r.query_json), createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() });
export function createView(db, { roomId, name, query, createdBy, now = Date.now() }) {
  ensure(db);
  const viewId = `view_${randomUUID().slice(0, 12)}`;
  db.prepare("INSERT INTO room_board_views (view_id, room_id, name, query_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(viewId, roomId, name, JSON.stringify(query), createdBy, now);
  return getView(db, { roomId, viewId });
}
export function getView(db, { roomId, viewId }) {
  ensure(db);
  const r = db.prepare("SELECT * FROM room_board_views WHERE room_id = ? AND view_id = ?").get(roomId, viewId);
  return r ? row(r) : null;
}
export function listViews(db, { roomId }) {
  ensure(db);
  return db.prepare("SELECT * FROM room_board_views WHERE room_id = ? ORDER BY created_at").all(roomId).map(row);
}
export function deleteView(db, { roomId, viewId }) {
  ensure(db);
  return db.prepare("DELETE FROM room_board_views WHERE room_id = ? AND view_id = ?").run(roomId, viewId).changes > 0;
}

// Merge a saved view under the request's own params (explicit params win).
export function withSavedView(params, view) {
  const merged = new URLSearchParams();
  for (const [key, value] of Object.entries(view.query)) merged.set(key, value);
  for (const [key, value] of params) if (key !== "savedView") merged.set(key, value);
  return merged;
}
