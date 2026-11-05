// Read-only census for the #5960 window. Between the deploy that stamped
// write grants at reduce time and the #6023 fix-forward, proposals by the
// owner or a write_external holder were granted without recording
// writeGrantPolicyVersion in the event. Their stored items carry the grant;
// a replay under the current reducer does not, so those rooms drift.
//
// This walks work.proposed events in (room_id, sequence) order, a bounded page
// at a time, and reports the unversioned ones whose stored item still holds a
// grant. Ids only: no titles, bodies or other member text.
import { readWorkItem } from "./work-repository.mjs";

const DEFAULT_SCAN = 2000;
const MAX_SCAN = 10000;
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parseScan(raw) {
  if (raw == null || raw === "") return DEFAULT_SCAN;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SCAN) throw Object.assign(new Error(`scan must be 1..${MAX_SCAN}`), { code: "invalid_scan" });
  return value;
}

function parseCursor(raw) {
  if (raw == null || raw === "") return { roomId: "", sequence: -1 };
  const at = raw.lastIndexOf(":");
  const roomId = raw.slice(0, at), sequence = Number(raw.slice(at + 1));
  if (at < 1 || !ROOM_ID.test(roomId) || !Number.isSafeInteger(sequence) || sequence < 0) throw Object.assign(new Error("after must be roomId:sequence"), { code: "invalid_cursor" });
  return { roomId, sequence };
}

export function writeGrantCensus(store, { after, scan } = {}) {
  const limit = parseScan(scan);
  const from = parseCursor(after);
  return store.readTransaction(() => {
    const rows = store.db.prepare(`SELECT room_id, sequence,
        json_extract(body,'$.type') AS type,
        json_extract(body,'$.data.writeGrantPolicyVersion') AS version,
        json_extract(body,'$.data.workItemId') AS workItemId,
        json_extract(body,'$.actorId') AS actorId,
        json_extract(body,'$.at') AS at
      FROM events WHERE (room_id > ? OR (room_id = ? AND sequence > ?))
      ORDER BY room_id, sequence LIMIT ?`).all(from.roomId, from.roomId, from.sequence, limit);
    const affected = [], unreadable = [];
    let proposals = 0;
    for (const row of rows) {
      if (row.type !== "work.proposed" || row.version != null || typeof row.workItemId !== "string") continue;
      proposals++;
      let item;
      try { item = readWorkItem(store.db, row.room_id, row.workItemId); }
      catch (error) { unreadable.push({ roomId: row.room_id, workItemId: row.workItemId, sequence: row.sequence, code: error?.code ?? "read_failed" }); continue; }
      if (!item?.externalWriteGrantBy) continue;
      affected.push({
        roomId: row.room_id, workItemId: row.workItemId, sequence: row.sequence, at: row.at,
        proposedBy: row.actorId, grantBy: item.externalWriteGrantBy, grantFor: item.externalWriteGrantFor ?? null
      });
    }
    const last = rows.at(-1);
    return {
      scanned: rows.length, unversionedProposals: proposals, affected, unreadable,
      next: rows.length === limit && last ? `${last.room_id}:${last.sequence}` : null,
      readAt: store.now()
    };
  });
}
