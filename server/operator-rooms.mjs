// Operator management panel, Slice 1 (MGMT-PANEL spec v2): the read-only
// half — a room list with live projection sizes, and a per-room export
// download behind the existing operator gate.
//
// No new credential, surface, or audit table: this rides the operator token,
// /operator.html, and operator_actions. The whole-store export door
// (ROOM_EXPORT_TOKEN) is untouched and not used here.
//
// Export friction (MF-6): exporting a room that is not lifecycle-archived
// requires the typed room id plus a reason (1-200 chars); the reason is
// stored in the room_export audit row. Lifecycle-archived rooms keep
// one-click export. Every export writes its audit row before the body is
// returned to the route, so no download exists unaudited.
//
// Export scrub (MF-7): event bodies are walked with scrubEventTokens
// (server/room-export.mjs), a recursive scrub over parsed event JSON for
// exactly three token shapes (pri_…, rak_…, ga1.…). The marker travels
// out-of-band — the X-Room-Export-Scrub response header and
// counts.scrubbed in the audit row — never as an in-band JSONL line, which
// would break the one-{sequence,event}-per-line contract. The export is
// still as sensitive as the room itself; the scrub is a narrow mitigation
// for this product's own token shapes, not a redaction of the export.

import { ServiceError } from "./service-error.mjs";
import { validId } from "../src/events.js";
import { appendOperatorAction } from "./operator-actions.mjs";
import { protectedRoomIds } from "./operator-purge.mjs";
import { scrubEventTokens } from "./room-export.mjs";
import { renderRoomExportHtml, EXPORT_HTML_CSP } from "./room-export-html.mjs";
import { redactEventRows } from "./redact-read.mjs";
import { PILOT_LIMITS } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const OPERATOR_ROOMS_DEFAULT_LIMIT = 100;
export const OPERATOR_ROOMS_MAX_LIMIT = 500;
export const ROOM_EXPORT_SCRUB_HEADER = "token-shapes";

function parseLimit(raw) {
  if (raw == null) return OPERATOR_ROOMS_DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > OPERATOR_ROOMS_MAX_LIMIT) {
    fail(422, "invalid_limit", `limit must be an integer from 1 to ${OPERATOR_ROOMS_MAX_LIMIT}`);
  }
  return limit;
}

// Member counts by kind from the projection, the same count operator-purge's
// activeHumanCount performs (active !== false), extended to every kind.
function memberCounts(projection) {
  const counts = {};
  let parsed = null;
  try { parsed = JSON.parse(projection); } catch { parsed = null; }
  const members = parsed?.members && typeof parsed.members === "object" ? Object.values(parsed.members) : [];
  for (const member of members) {
    if (!member || typeof member !== "object" || member.active === false) continue;
    const kind = typeof member.kind === "string" && member.kind ? member.kind : "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return { counts, messagesArchived: Boolean(parsed?.messagesArchive) };
}

export function listOperatorRooms(store, rawLimit) {
  const limit = parseLimit(rawLimit);
  const capBytes = PILOT_LIMITS.projectionBytes;
  const protectedIds = protectedRoomIds();
  const rows = store.db.prepare(`SELECT id, length(CAST(projection AS BLOB)) AS projectionBytes, sequence, archived_at,
      json_extract(projection, '$.room.title') AS title, projection
    FROM rooms ORDER BY projectionBytes DESC, id LIMIT ?`).all(limit + 1);
  const truncated = rows.length > limit;
  const rooms = rows.slice(0, limit).map(row => {
    const { counts, messagesArchived } = memberCounts(row.projection);
    return {
      id: row.id,
      title: typeof row.title === "string" ? row.title : null,
      projectionBytes: row.projectionBytes,
      capBytes,
      percentOfCap: capBytes > 0 ? row.projectionBytes / capBytes : 0,
      headSeq: row.sequence,
      archived: row.archived_at != null,
      archivedAt: row.archived_at ?? null,
      protected: protectedIds.has(row.id),
      activeMembersByKind: counts,
      messagesArchived
    };
  });
  return { rooms, truncated, readAt: store.now(), capBytes };
}

function roomRow(store, roomId) {
  return store.db.prepare("SELECT id, sequence, archived_at FROM rooms WHERE id=?").get(roomId) ?? null;
}

// The event walk, mirroring store.exportEvents' paging over the events
// table (the operator holds no room member token, so the walk is read
// directly here; it is the same table, order, and page shape). Read-time
// redaction is applied exactly as the room export route applies it, so a
// deleted message's earlier body does not leave in an operator export.
export function walkRoomEvents(store, roomId) {
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId)?.sequence ?? 0;
  const stmt = store.db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1000");
  const rows = [];
  let after = 0;
  for (;;) {
    const page = stmt.all(roomId, after);
    if (!page.length) break;
    for (const row of page) rows.push({ sequence: row.sequence, event: JSON.parse(row.body) });
    after = page.at(-1).sequence;
    if (after >= head) break;
  }
  return redactEventRows(rows, store.redactionMessages(roomId));
}

export function operatorRoomExport(store, roomId, { format = "jsonl", confirmRoomId = null, reason = null } = {}, requestId = null) {
  if (!validId(roomId)) fail(422, "invalid_room_id", "roomId must be a room id");
  if (format !== "jsonl" && format !== "html") fail(422, "invalid_format", "format is jsonl (default) or html");
  const room = roomRow(store, roomId);
  if (!room) fail(404, "room_not_found", "Room not found");
  const archived = room.archived_at != null;
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason.length > 200) fail(422, "reason_required", "Give a reason of 1 to 200 characters");
  if (!archived) {
    // MF-6: a live room's full history does not leave on one click.
    if (confirmRoomId !== roomId) fail(422, "confirmation_required", "Type the exact room id to export a room that is not archived");
    if (!trimmedReason) fail(422, "reason_required", "Give a reason of 1 to 200 characters");
  }
  const walked = walkRoomEvents(store, roomId);
  const scrubbedRows = walked.map(row => ({ sequence: row.sequence, event: scrubEventTokens(row.event) }));
  let body;
  let contentType;
  const headers = { "X-Room-Export-Scrub": ROOM_EXPORT_SCRUB_HEADER };
  if (format === "html") {
    body = Buffer.from(renderRoomExportHtml(scrubbedRows, { roomId }), "utf8");
    contentType = "text/html; charset=utf-8";
    headers["Content-Security-Policy"] = EXPORT_HTML_CSP;
  } else {
    body = Buffer.from(scrubbedRows.map(row => `${JSON.stringify(row)}\n`).join(""), "utf8");
    contentType = "application/x-ndjson; charset=utf-8";
  }
  const date = new Date(store.now());
  const yyyymmdd = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10).replaceAll("-", "") : "unknown-date";
  const filename = `room-${roomId}-${yyyymmdd}-seq${room.sequence}.${format === "html" ? "html" : "jsonl"}`;
  // Audit before the route sends the body (spec §2.2 / §7): a failed
  // download can leave an ok row, never an unaudited download.
  appendOperatorAction(store, {
    action: "room_export",
    targetKind: "room",
    targetId: roomId,
    reason: trimmedReason || null,
    counts: { format, events: scrubbedRows.length, bytes: body.length, scrubbed: true },
    result: "ok",
    requestId
  });
  return { body, contentType, filename, headers, events: scrubbedRows.length, headSeq: room.sequence };
}
