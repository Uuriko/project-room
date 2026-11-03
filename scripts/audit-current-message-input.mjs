// Read-only, one indexed scalar page. This is a size census, not a proof audit.
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {MESSAGE_PROOF_FIELDS} from '../server/write-integrity.mjs';
export const MESSAGE_CENSUS_BYTES = 917504;
export function messageInputPageSql({selectedRoom = false} = {}) {
  const bytes = MESSAGE_PROOF_FIELDS.map(key => `coalesce(length(CAST(m.${key} AS BLOB)),0)`).join('+');
  return `SELECT m.room_id,m.message_id,${bytes} AS proof_bytes,
    coalesce(length(CAST(m.body AS BLOB)),0) AS body_bytes,
    coalesce(length(CAST(m.record_json AS BLOB)),0) AS record_bytes,
    coalesce(length(CAST(m.reducer_extras_json AS BLOB)),0) AS extras_bytes,
    EXISTS(SELECT 1 FROM current_room_head h WHERE h.room_id=m.room_id) AS normalized
    FROM messages m WHERE ${selectedRoom ? 'm.room_id=? AND m.message_id>?' : '(m.room_id,m.message_id)>(?,?)'}
    ORDER BY m.room_id,m.message_id LIMIT ?`;
}
export function auditMessageInputPage(db, {roomId, after = null, limit = 20} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('limit must be 1..20');
  if (roomId !== undefined && (typeof roomId !== 'string' || !roomId)) throw Error('roomId must be nonempty');
  if (after !== null && (!Array.isArray(after) || after.length !== 2 || after.some(v => typeof v !== 'string') || roomId !== undefined && after[0] !== roomId)) throw Error('invalid selected cursor');
  const bindings = roomId === undefined ? [after?.[0] ?? '', after?.[1] ?? '', limit] : [roomId, after?.[1] ?? '', limit];
  const rows = db.prepare(messageInputPageSql({selectedRoom: roomId !== undefined})).all(...bindings);
  const classes = {legacy: 0, withinFormer128KiB: 0, aboveFormer128KiB: 0, aboveDerivedCeiling: 0};
  let maxProofBytes = 0;
  for (const row of rows) {
    if (!row.normalized) { classes.legacy++; continue; }
    maxProofBytes = Math.max(maxProofBytes, row.proof_bytes);
    if (row.proof_bytes > MESSAGE_CENSUS_BYTES) classes.aboveDerivedCeiling++;
    else if (row.proof_bytes > 131072) classes.aboveFormer128KiB++;
    else classes.withinFormer128KiB++;
  }
  return {examined: rows.length, classes, maxProofBytes, inputCeiling: MESSAGE_CENSUS_BYTES,
    complete: rows.length < limit, next: rows.length === limit ? [rows.at(-1).room_id, rows.at(-1).message_id] : null,
    qualification: 'Scalar size classes only; history/UTF-16/metadata and independent proofs still require the qualified reader. A full page may have an empty next page.'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, roomId, cursor] = process.argv.slice(2);
  if (!path) throw Error('Usage: node scripts/audit-current-message-input.mjs DATABASE [ROOM_ID] [CURSOR_JSON]');
  const db = new DatabaseSync(path, {readOnly: true});
  try { console.log(JSON.stringify(auditMessageInputPage(db, {roomId, after: cursor ? JSON.parse(cursor) : null}))); }
  finally { db.close(); }
}
