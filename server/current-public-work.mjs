import {validId, publicPage, publicTask} from '../src/events.js';
import {ServiceError} from './service-error.mjs';
import {conversationCursorCodec} from './conversation-sync.mjs';
import {CURRENT_PUBLIC_WORK_PREDICATE,
  withCurrentReadContext, readCurrentHead, readCurrentRecord,
  withCurrentWorkReadUnits, readCurrentWorkPrivacy, chargeCurrentReadBudget} from './current-room-repository.mjs';

export const CURRENT_PUBLIC_WORK_LIMIT = 4;
const MAX_PAGE_PAYLOAD_BYTES = 256 * 1024;
const corrupt = message => {throw Error('current_room_corrupt: ' + message);};

// Caller must first resolve the explicitly published room. This second check
// uses protected current metadata, inside the same synchronous read snapshot.
// The index is discovery only; every disclosed task retains its independent
// current membership/reference and complete payload-hash verification.
// Sitemap gate: the same published/not-archived check readCurrentPublicWork
// applies, without reading tasks. Unreadable metadata is not listed.
export function currentPublicPageListed(store, roomId) {
  try {
    return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
      const head = readCurrentHead(store.db, roomId, b);
      const room = readCurrentRecord(store.db, roomId, 'metadata', 'room', b);
      return Boolean(head && room?.id === roomId && publicPage({room}).enabled && !room.archivedAt);
    }));
  } catch { return false; }
}

export function readCurrentPublicWork(store, roomId, {after = ''} = {}) {
  if (typeof after !== 'string')
    throw new ServiceError(422, 'invalid_feed_cursor', 'Invalid public task page; reload the room');
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const db = store.db, head = readCurrentHead(db, roomId, b);
    const room = readCurrentRecord(db, roomId, 'metadata', 'room', b);
    if (!head || room?.id !== roomId) corrupt('public room metadata unavailable');
    if (!publicPage({room}).enabled || room.archivedAt) return null;
    const codec = conversationCursorCodec(store);
    let sourceAfter = '';
    if (after) {
      const saved = codec.decode(after);
      if (!saved || saved.v !== 1 || saved.type !== 'public-work' || saved.roomId !== roomId
        || Object.keys(saved).length !== 4 || !validId(saved.after))
        throw new ServiceError(422, 'invalid_feed_cursor', 'Public task page expired; reload the room');
      sourceAfter = saved.after;
    }
    const rows = db.prepare(`SELECT work_id, length(CAST(body AS BLOB)) AS bytes
      FROM work_entities INDEXED BY current_public_work_keys
      WHERE room_id=? AND ${CURRENT_PUBLIC_WORK_PREDICATE} AND work_id>?
      ORDER BY work_id LIMIT ?`).all(roomId, sourceAfter, CURRENT_PUBLIC_WORK_LIMIT + 1);
    chargeCurrentReadBudget(b, rows.reduce((sum, row) => sum + Buffer.byteLength(row.work_id) + 64, 0), rows.length);
    const tasks = [];
    let payloadBytes = 0, examined = 0, examinedAfter = sourceAfter;
    withCurrentWorkReadUnits(store, roomId, unit => {
      for (const row of rows.slice(0, CURRENT_PUBLIC_WORK_LIMIT)) {
        if (!validId(row.work_id)) corrupt('public work candidate identity differs');
        // Private request association restricts previously published tasks,
        // just as it does for nonparty member reads. No task body is needed
        // for this protected denial, and its ID stays inside an opaque cursor.
        if (readCurrentWorkPrivacy(db, roomId, row.work_id, b).requests) {
          examined++; examinedAfter = row.work_id; continue;
        }
        if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 128 * 1024)
          corrupt('public work candidate exceeds supported payload');
        // Admit whole task bodies before crossing into JS. A page may hold
        // fewer than four large tasks, but never labels a truncated task full.
        if (payloadBytes + row.bytes > MAX_PAGE_PAYLOAD_BYTES) break;
        const item = unit.work(row.work_id);
        if (!item || publicTask(item).enabled !== true
          || !['proposed', 'accepted', 'working', 'blocked'].includes(item.state)
          || typeof item.title !== 'string' || typeof item.definitionOfDone !== 'string')
          corrupt('public task differs from protected current record');
        payloadBytes += row.bytes;
        tasks.push({id:item.id, title:item.title, definitionOfDone:item.definitionOfDone});
        examined++; examinedAfter = row.work_id;
      }
    });
    const hasMore = rows.length > examined;
    return {tasks, coverage:{available:true, bounded:true, limit:CURRENT_PUBLIC_WORK_LIMIT,
      order:'id', after:after || null, hasMore,
      nextAfter:hasMore ? codec.encode({v:1,type:'public-work',roomId,after:examinedAfter}) : null,
      assignmentGranted:false, executionGranted:false}};
  }));
}


// One explicitly published open task, never a scan of an unrelated page.
// Return null for all unavailable identities; membership/private associations
// cannot be inferred from the public result. Corrupt proof data still fails shut.
export function readCurrentPublicTask(store, roomId, workId) {
  if (!validId(workId)) return null;
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const db = store.db, head = readCurrentHead(db, roomId, b);
    const room = readCurrentRecord(db, roomId, 'metadata', 'room', b);
    if (!head || room?.id !== roomId) corrupt('public room metadata unavailable');
    if (!publicPage({room}).enabled || room.archivedAt) return null;
    const row = db.prepare(`SELECT work_id, length(CAST(body AS BLOB)) AS bytes
      FROM work_entities INDEXED BY current_public_work_keys
      WHERE room_id=? AND ${CURRENT_PUBLIC_WORK_PREDICATE} AND work_id=?`).get(roomId, workId);
    if (!row) return null;
    chargeCurrentReadBudget(b, Buffer.byteLength(row.work_id) + 64, 1);
    if (readCurrentWorkPrivacy(db, roomId, workId, b).requests) return null;
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 128 * 1024)
      corrupt('public work candidate exceeds supported payload');
    return withCurrentWorkReadUnits(store, roomId, unit => {
      const item = unit.work(workId);
      if (!item || item.id !== workId || publicTask(item).enabled !== true
        || !['proposed', 'accepted', 'working', 'blocked'].includes(item.state)
        || typeof item.title !== 'string' || typeof item.definitionOfDone !== 'string'
        || !Number.isSafeInteger(item.revision) || item.revision < 0)
        corrupt('public task differs from protected current record');
      return {id:item.id, title:item.title, definitionOfDone:item.definitionOfDone,
        state:item.state, revision:item.revision};
    });
  }));
}
