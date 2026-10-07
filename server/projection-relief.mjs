// H1 relief valve: graceful degradation at the rooms.projection size cap.
//
// The 4MiB projection cap used to be a hard 409 dead-end: no telemetry, no
// warning, no recovery — during the 2026-10-07 muse-room incident every
// state-changing write 409'd with pilot_limit. This module makes the cap
// graceful in two parts:
//
// (1) Telemetry + warnings. Every room write records its stored-projection
//     size (a bounded per-room ring) and, on pressure (the size the write
//     would have stored, before any relief), fires a room-scoped warning
//     exactly once per threshold at 70/85/95% of the cap. Warnings are
//     logged (stderr, structured) and room-visible via Store#projectionHealth
//     and the diagnostics route's additive projectionHealth field.
//
// (2) Archival paging. When a write would exceed the cap, one deterministic
//     pass pages every remaining inline message body shorter than
//     BODY_AT_REST_MIN_CHARS out to projection_bodies — the same
//     content-addressed side table Phase 1a uses, so hydration, reads, and
//     the release trigger are unchanged. Long bodies are deliberately NOT
//     paged here: the at-rest slimming already handles them (or the room
//     runs with slimming off, in which case the cap still means the cap).
//     If the paged row fits, the write lands; only then does the 409 fire.
//
// Backward compatibility: additive side tables only (no events, no
// projection impact); the relief pass reuses the bodyRef convention every
// reader already hydrates; the 409 code/message are untouched; telemetry
// failures are fail-closed (see Store#observeProjection) so a telemetry
// outage can never break a room write.
import { createHash } from "node:crypto";
import { BODY_AT_REST_MIN_CHARS } from "./projection-at-rest.mjs";

// Warning thresholds as fractions of PILOT_LIMITS.projectionBytes.
export const PROJECTION_WARN_THRESHOLDS = Object.freeze([0.70, 0.85, 0.95]);

// Telemetry ring: samples kept per room. Warnings: one row per threshold per
// room — INSERT OR IGNORE is the edge trigger, so each threshold fires once.
export const RELIEF_SCHEMA = `
CREATE TABLE IF NOT EXISTS projection_telemetry (
  room_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  pressure_bytes INTEGER NOT NULL,
  ratio REAL NOT NULL,
  pressure_ratio REAL NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (room_id, sequence)
);
CREATE INDEX IF NOT EXISTS projection_telemetry_room_seq ON projection_telemetry(room_id, sequence DESC);
CREATE TABLE IF NOT EXISTS projection_warnings (
  room_id TEXT NOT NULL,
  threshold REAL NOT NULL,
  bytes INTEGER NOT NULL,
  ratio REAL NOT NULL,
  sequence INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (room_id, threshold)
);`;

export const TELEMETRY_KEEP_PER_ROOM = 200;

const shaOf = body => createHash("sha256").update(body, "utf8").digest("hex");

// Record one write's projection size. `bytes` is what will be stored;
// `pressure` is what the write would have stored before any relief pass
// (equal when no relief ran). Warnings evaluate on pressure, so a near-miss
// the valve absorbed still warns. Returns { bytes, ratio, pressureRatio, fired }.
// The caller (Store#observeProjection) wraps this so telemetry can never throw
// into a room write.
export function recordProjectionSample(db, { roomId, sequence, bytes, pressure, capBytes, at }) {
  const stored = Math.max(0, bytes | 0);
  const pushed = Math.max(stored, pressure | 0);
  const stamp = typeof at === "string" && at ? at : new Date().toISOString();
  const ratio = stored / capBytes;
  const pressureRatio = pushed / capBytes;
  db.prepare(`INSERT OR REPLACE INTO projection_telemetry
    (room_id, sequence, bytes, pressure_bytes, ratio, pressure_ratio, at)
    VALUES (?,?,?,?,?,?,?)`).run(roomId, sequence, stored, pushed, ratio, pressureRatio, stamp);
  db.prepare(`DELETE FROM projection_telemetry WHERE room_id = ? AND sequence NOT IN (
    SELECT sequence FROM projection_telemetry WHERE room_id = ? ORDER BY sequence DESC LIMIT ?)`).run(roomId, roomId, TELEMETRY_KEEP_PER_ROOM);
  const fired = [];
  for (const threshold of PROJECTION_WARN_THRESHOLDS) {
    if (pressureRatio < threshold) continue;
    const inserted = db.prepare(`INSERT OR IGNORE INTO projection_warnings
      (room_id, threshold, bytes, ratio, sequence, at) VALUES (?,?,?,?,?,?)`)
      .run(roomId, threshold, pushed, pressureRatio, sequence, stamp);
    if (inserted.changes === 1) fired.push(threshold);
  }
  return { bytes: stored, ratio, pressureRatio, fired };
}

// One deterministic archival pass: page every remaining inline message body
// shorter than BODY_AT_REST_MIN_CHARS out to projection_bodies, swapping
// `body` for `bodyRef` (sha256) in place so key order is preserved.
// Returns the slimmed projection text, or null when nothing was pageable.
export function pageOutInlineBodies(db, roomId, state) {
  const messages = Array.isArray(state?.messages) ? state.messages : null;
  if (!messages) return null;
  const insert = db.prepare("INSERT OR IGNORE INTO projection_bodies(room_id, sha, body) VALUES(?,?,?)");
  let moved = 0;
  const slim = messages.map(message => {
    if (!message || typeof message.body !== "string" || message.body.length === 0
      || message.body.length >= BODY_AT_REST_MIN_CHARS || "bodyRef" in message) return message;
    const sha = shaOf(message.body);
    insert.run(roomId, sha, message.body);
    moved += 1;
    const out = {};
    for (const [key, value] of Object.entries(message)) out[key === "body" ? "bodyRef" : key] = key === "body" ? sha : value;
    return out;
  });
  if (moved === 0) return null;
  return JSON.stringify({ ...state, messages: slim });
}

// Attempt the relief valve. Returns { projection, bytes } when the paged row
// fits under the cap, else null. Never throws: on any failure the caller's
// 409 stands (fail-closed).
export function attemptProjectionRelief(db, roomId, state, capBytes) {
  try {
    const projection = pageOutInlineBodies(db, roomId, state);
    if (projection === null) return null;
    const bytes = Buffer.byteLength(projection);
    return bytes <= capBytes ? { projection, bytes } : null;
  } catch {
    return null;
  }
}

// Room-visible health snapshot for the diagnostics route. Read-only; null
// when the room has no recorded write yet (or the tables predate the schema).
export function readProjectionHealth(db, roomId, capBytes) {
  const row = db.prepare("SELECT LENGTH(projection) AS bytes FROM rooms WHERE id=?").get(roomId);
  if (!row) return null;
  const warnings = db.prepare(
    "SELECT threshold, bytes, ratio, sequence, at FROM projection_warnings WHERE room_id=? ORDER BY threshold").all(roomId);
  const latest = db.prepare(
    "SELECT sequence, bytes, pressure_bytes AS pressureBytes, ratio, pressure_ratio AS pressureRatio, at FROM projection_telemetry WHERE room_id=? ORDER BY sequence DESC LIMIT 1").get(roomId)
    ?? null;
  return {
    roomId, capBytes, bytes: row.bytes, ratio: row.bytes / capBytes,
    thresholds: [...PROJECTION_WARN_THRESHOLDS], warnings, latest,
  };
}
