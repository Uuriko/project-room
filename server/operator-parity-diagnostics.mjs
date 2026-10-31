// Metadata-only comparison of outstanding message parity failures. Never certifies,
// replays, repairs, or calls store.room(), whose recovery path can write.
import { hydrateProjection } from './projection-at-rest.mjs';
import { affectedMessageIds, messageRowParityFields, messageRecordParityDetail } from './messages-store.mjs';

const LIMITS = Object.freeze({ rooms: 5, rows: 500, events: 2000, bytes: 4 * 1024 * 1024, budgetMs: 150 });
const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export function operatorParityDiagnostics(store, { now = () => performance.now(), budgetMs = LIMITS.budgetMs } = {}) {
  const started = now(), expired = () => now() - started >= Math.min(LIMITS.budgetMs, Math.max(0, budgetMs));
  return store.readTransaction(() => {
    const db = store.db;
    if (!exists(db, 'integrity_failures')) return { rooms: [], truncated: false };
    const failures = db.prepare("SELECT record_id AS roomId,last_seen_at AS recordedAt FROM integrity_failures WHERE step='messages_parity' AND record_id!='' ORDER BY record_id LIMIT ?").all(LIMITS.rooms + 1);
    const rooms = failures.slice(0, LIMITS.rooms).map(failure => {
      const result = { ...failure, status: 'unknown', complete: false, exactLegacyShapeOnly: false };
      const unknown = reason => ({ ...result, reason });
      try {
        if (expired()) return unknown('budget_exceeded');
        const size = db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?').get(failure.roomId);
        if (!size) return unknown('room_missing');
        result.head = size.sequence;
        if (size.bytes > LIMITS.bytes) return unknown('byte_limit');
        const cursor = db.prepare('SELECT applied_seq,parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get(failure.roomId);
        result.appliedSequence = cursor?.applied_seq ?? null;
        result.certifiedSequence = cursor?.parity_at_seq ?? null;
        if (cursor?.applied_seq !== size.sequence) return unknown('not_caught_up');
        const projection = JSON.parse(db.prepare('SELECT projection FROM rooms WHERE id=?').get(failure.roomId).projection);
        if (!Array.isArray(projection.messages) || projection.messages.length > LIMITS.rows) return unknown('row_limit');
        // Bound materialized rows and bytes before parsing or hydrating entities.
        const bounded = db.prepare('SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(coalesce(body,\'\') AS BLOB))+length(CAST(coalesce(record_json,\'\') AS BLOB))+length(CAST(coalesce(reducer_extras_json,\'\') AS BLOB)) AS nbytes FROM messages WHERE room_id=? LIMIT ?)').get(failure.roomId, LIMITS.rows + 1);
        if (bounded.n > LIMITS.rows) return unknown('row_limit');
        if (bounded.bytes > LIMITS.bytes) return unknown('byte_limit');
        if (exists(db, 'projection_bodies')) {
          const bodies = db.prepare('SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(body AS BLOB)) AS nbytes FROM projection_bodies WHERE room_id=? LIMIT ?)').get(failure.roomId, LIMITS.rows + 1);
          if (bodies.n > LIMITS.rows || bodies.bytes > LIMITS.bytes) return unknown('body_limit');
        }
        const eventSize = db.prepare("SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(body AS BLOB)) AS nbytes FROM events WHERE room_id=? LIMIT ?)").get(failure.roomId, LIMITS.events + 1);
        if (eventSize.n > LIMITS.events || eventSize.bytes > LIMITS.bytes) return unknown('event_limit');
        if (expired()) return unknown('budget_exceeded');
        const hydrated = hydrateProjection(db, failure.roomId, projection, { verifyBodyHashes: true, workEntities: false });
        if (hydrated.missing.length) return unknown('body_missing');
        const state = hydrated.state, messages = new Map(state.messages.map(message => [message.id, message]));
        const rows = db.prepare('SELECT * FROM messages WHERE room_id=? LIMIT ?').all(failure.roomId, LIMITS.rows + 1);
        const sequences = new Map(), receipts = new Map(); let postedLastSequence = 0;
        for (const event of db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence LIMIT ?").all(failure.roomId, LIMITS.events + 1)) {
          if (expired()) return unknown('budget_exceeded');
          const body = JSON.parse(event.body);
          if (body.type !== 'message.posted') continue;
          postedLastSequence = event.sequence;
          for (const id of affectedMessageIds(body)) if (!sequences.has(id)) { sequences.set(id, event.sequence); receipts.set(id, body.data?.receiptId ?? null); }
        }
        const archive = state.messagesArchive, retained = new Set(archive?.retainedIds ?? []);
        const archived = row => archive && row.seq <= archive.throughSeq && !retained.has(row.message_id);
        const threadMessages = new Map([...rows.filter(archived).map(row => [row.message_id, { id: row.message_id, replyToId: row.reply_to_id }]), ...messages]);
        const pins = new Set((state.pins ?? []).map(pin => pin.messageId));
        const fields = new Set(), keys = new Set(); let mismatchedRows = 0, legacyOnly = true;
        const rowIds = new Set(rows.map(row => row.message_id));
        const missingRows = state.messages.filter(message => !rowIds.has(message.id)).length;
        const extraRows = rows.filter(row => !archived(row) && !messages.has(row.message_id)).length;
        if (rows.length !== state.messages.length + (archive?.count ?? 0)) fields.add('row_count');
        if (Math.max(0, ...rows.map(row => row.seq)) !== postedLastSequence) fields.add('last_sequence');
        if (missingRows) fields.add('missing_row');
        if (extraRows) fields.add('extra_row');
        if (rows.filter(archived).length !== (archive?.count ?? 0)) fields.add('archive_count');
        for (const row of rows.filter(row => !archived(row))) {
          if (expired()) return unknown('budget_exceeded');
          const message = messages.get(row.message_id);
          const differences = messageRowParityFields(row, message, { sequence: sequences.get(message?.id), pinned: pins.has(message?.id), threadMessages });
          if (!differences.length) continue;
          mismatchedRows++;
          for (const field of differences) fields.add(field);
          const detail = message && differences.includes('record_json') ? messageRecordParityDetail(row, message, receipts.get(message.id)) : null;
          for (const key of detail?.keys ?? []) keys.add(key);
          if (differences.length !== 1 || differences[0] !== 'record_json' || !detail?.legacyShapeOnly) legacyOnly = false;
        }
        if (expired()) return unknown('budget_exceeded');
        return { ...result, complete: true, status: fields.size ? 'mismatch' : 'clean',
          missingRows, extraRows, mismatchedRows, fields: [...fields].sort(), recordJsonKeys: [...keys].sort(),
          exactLegacyShapeOnly: fields.size === 1 && fields.has('record_json') && legacyOnly };
      } catch { return unknown('comparison_unavailable'); }
    });
    return { rooms, truncated: failures.length > LIMITS.rooms, limits: LIMITS };
  });
}
