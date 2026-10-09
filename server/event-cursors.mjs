// WAVE-500 W12: cursor survival across compaction/rotation.
//
// DESIGN — why epoch markers, not the alternatives
//
// Problem: every event-log consumer addresses the log by sequence — SSE
// `after` cursors (server/http.mjs:849, resumed via Last-Event-ID at
// http.mjs:4853), GET /api/rooms/:roomId/events (http.mjs:4832),
// store.eventsAfter (server/store.mjs:4309), the MCP room_list_events
// reader (server/mcp-room-profile.mjs:528), the updates tail walk
// (server/updates.mjs:657). Today sequences are dense and monotonic per
// room. Compaction (W4/W5) rewrites the log in place and rotation (W11,
// docs/wave500/ROOM-ROTATION-DESIGN.md) retires the room; both break the
// dense-monotonic assumption, so a cursor issued before the rewrite can
// silently skip events or replay them after it.
//
// Options considered:
//   1. Cursor-translation table (old seq -> new seq per compaction).
//      Rejected: unbounded growth (one row per compacted event), a hot
//      write on every compact, and it has to live in the archive too for
//      rotation. It optimises the cold path (resuming mid-compacted
//      prefix) that readers almost never need.
//   2. Dense renumbering with a mapping log. Rejected: renumbering up to
//      1M rows (PILOT_LIMITS, store.mjs:427) is a huge write; the mapping
//      log is again unbounded and would have to be consulted on every
//      page read. Also, the export route ALREADY renumbers per-viewer
//      (http.mjs:4196-4210) and those sequences must never be fed back as
//      `after` — any design that renumbers stored rows invites exactly
//      that hazard.
//   3. Epoch markers (CHOSEN). Compaction/rotation bumps one integer on the
//      room row, committed in the SAME transaction that installs the
//      rewritten log — so correctness under concurrent write + compact is
//      inherited from the existing write fence: a reader whose cursor
//      predates the bump sees epoch != current and the server fails closed
//      (409 cursor_epoch_stale with the current head, mirroring the
//      existing 409 cursor_ahead in eventsAfter), instead of silently
//      skipping or duplicating. The failure mode is detectable and honest,
//      which is the invariant that matters: duplicates are idempotent for
//      clients (events carry stable ids), silent loss is not.
//
// Why epochs win on simplicity: one integer column, no mapping tables, and
// the cursor stays a SINGLE STRING, which is exactly what the existing
// surfaces can carry — query params (?after=), SSE `id:` lines (which must
// be one line; today `id: ${item.sequence}`), and Last-Event-ID. A JSON
// cursor object would not fit any of them.
//
// Backward compat: legacy bare "123" decodes to { epoch: 0, seq: 123 },
// and encode emits a bare integer for epoch 0 — so every cursor a client
// already holds, and every test that pages with after=0, keeps working
// byte-for-byte. A room that has never been compacted or rotated lives at
// epoch 0 forever.
//
// This module is pure: no DB, no store coupling. The server-side wiring
// (reading rooms.log_epoch, comparing in eventsAfter, bumping on compact)
// is left to a follow-up worker; nothing here changes existing consumers.

const LEGACY_CURSOR_RE = /^(0|[1-9]\d*)$/;
const EPOCH_CURSOR_RE = /^e(0|[1-9]\d*):(0|[1-9]\d*)$/;

function invalidCursor(detail) {
  const error = new Error(`invalid_cursor: ${detail}`);
  error.code = "invalid_cursor";
  return error;
}

function requireSafeUint(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidCursor(`${name} must be a non-negative safe integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalize(cursor) {
  if (typeof cursor === "string") return decodeCursor(cursor);
  if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
    const { epoch, seq } = cursor;
    requireSafeUint(epoch, "epoch");
    requireSafeUint(seq, "seq");
    return { epoch, seq };
  }
  throw invalidCursor(`cursor must be a string or {epoch, seq}, got ${JSON.stringify(cursor)}`);
}

/**
 * Encode a cursor to its wire form: bare "<seq>" for epoch 0 (identical to
 * today's cursors), "e<epoch>:<seq>" for later epochs. URL-safe, single
 * line — fits query params, SSE id: lines, and Last-Event-ID.
 */
export function encodeCursor(cursor = {}) {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw invalidCursor(`cursor must be {epoch, seq}, got ${JSON.stringify(cursor)}`);
  }
  const { epoch, seq } = cursor;
  requireSafeUint(epoch, "epoch");
  requireSafeUint(seq, "seq");
  return epoch === 0 ? String(seq) : `e${epoch}:${seq}`;
}

/**
 * Decode a wire cursor. Accepts legacy bare "<seq>" (epoch 0) and
 * "e<epoch>:<seq>". Anything else — empty, negative, fractional,
 * non-numeric, over-long, non-string — throws invalid_cursor.
 */
export function decodeCursor(text) {
  if (typeof text !== "string") throw invalidCursor(`cursor must be a string, got ${typeof text}`);
  let m = LEGACY_CURSOR_RE.exec(text);
  if (m) return { epoch: 0, seq: Number(m[1]) };
  m = EPOCH_CURSOR_RE.exec(text);
  if (m) {
    const epoch = Number(m[1]);
    const seq = Number(m[2]);
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) throw invalidCursor("cursor component exceeds safe integer range");
    return { epoch, seq };
  }
  throw invalidCursor(`unrecognized cursor shape: ${JSON.stringify(text)}`);
}

/**
 * Total order over cursors: epoch dominates, then sequence. Returns -1, 0,
 * or 1. Accepts wire strings or {epoch, seq} objects in any mix.
 */
export function compareCursors(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (x.epoch !== y.epoch) return x.epoch < y.epoch ? -1 : 1;
  if (x.seq !== y.seq) return x.seq < y.seq ? -1 : 1;
  return 0;
}
