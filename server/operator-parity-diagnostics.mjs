// Metadata-only comparison of outstanding message parity failures. Never certifies,
// replays, repairs, or calls store.room(), whose recovery path can write.
import { assertProjectionWrite, MESSAGE_PROOF_FIELDS, MESSAGE_PROOF_SELECT, messageProofMatches, servingProofDrift } from './write-integrity.mjs';
import { hydrateProjection } from './projection-at-rest.mjs';
import { affectedMessageIds, archiveMarker, messagesBackfillCaughtUp, messageRowParityFields, messageRecordParityDetail } from './messages-store.mjs';

const LIMITS = Object.freeze({ rooms: 5, rows: 2000, events: 2000, bytes: 4 * 1024 * 1024, budgetMs: 150 });
const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export const SELECTED_PARITY_LIMITS = Object.freeze({ rooms: 1, rows: 64, events: 64, bytes: 256 * 1024, responseBytes: 4096, budgetMs: 150 });

// Only scalar results cross SQL before admission. LIMIT applies to each indexed
// room range before aggregation, including malformed rows. Size is UTF-8 octets,
// with conservative per-column JSON overhead; this is not a physical-I/O bound.
function admitSelected(db, roomId) {
  const domains = [
    ['rooms', 'id', ['id','projection'], ['sequence']],
    ['events', 'room_id', ['id','room_id','body'], ['sequence']],
    ['messages', 'room_id', ['room_id', ...MESSAGE_PROOF_FIELDS.filter(key => !['seq','pinned'].includes(key)), 'entity_hash'], ['seq','pinned']],
    ['projection_bodies', 'room_id', ['room_id','sha','body'], []],
    ['work_entities', 'room_id', ['room_id','work_id','digest','body'], ['revision']],
    ['integrity_room_state', 'room_id', ['room_id','projection_hash','metadata_hash'], ['sequence','projection_bytes']],
    ['messages_backfill_cursor', 'room_id', ['room_id','applied_event_id','replay_event_id','sweep_after'], ['applied_seq','state_seq','parity_at_seq']]
  ];
  let bytes = 1024;
  const counts = {};
  for (const [table, key, texts, numbers] of domains) {
    if (!exists(db, table)) return { reason: 'schema_unavailable' };
    const columns = [...texts, ...numbers];
    const invalid = [...texts.map(name => `(typeof(${name}) NOT IN ('text','null'))`),
      ...numbers.map(name => `(typeof(${name}) NOT IN ('integer','null') OR (typeof(${name})='integer' AND (${name}<0 OR ${name}>9007199254740991)))`)];
    if (table === 'events') invalid.push('(length(CAST(id AS BLOB))>256)');
    const lengths = columns.map(name => `coalesce(length(CAST(${name} AS BLOB)),0)+32`).join('+');
    const row = db.prepare(`SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes,coalesce(max(invalid),0) AS invalid FROM (SELECT ${lengths} AS nbytes,CASE WHEN ${invalid.join(' OR ')} THEN 1 ELSE 0 END AS invalid FROM ${table} WHERE ${key}=? LIMIT 65)`).get(roomId);
    if (row.invalid) return { reason: 'invalid_scalar' };
    if (row.n > (['rooms','integrity_room_state','messages_backfill_cursor'].includes(table) ? 1 : 64)) return { reason: 'row_limit' };
    bytes += row.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > SELECTED_PARITY_LIMITS.bytes) return { reason: 'byte_limit' };
    counts[table] = row.n;
  }
  return { inputBytes: bytes, events: counts.events, messages: counts.messages, bodies: counts.projection_bodies, workEntities: counts.work_entities };
}

export function operatorSelectedParityDiagnostics(store, selection) {
  return parityDiagnostics(store, {}, selection);
}
export function operatorParityDiagnostics(store, options = {}) {
  return parityDiagnostics(store, options);
}
function parityDiagnostics(store, { now = () => performance.now(), budgetMs = LIMITS.budgetMs } = {}, selection) {
  const limits = selection ? SELECTED_PARITY_LIMITS : LIMITS;
  const started = now(), expired = () => now() - started >= Math.min(LIMITS.budgetMs, Math.max(0, budgetMs));
  return store.readTransaction(() => {
    const db = store.db;
    if (!selection && !exists(db, 'integrity_failures')) return { rooms: [], truncated: false };
    const failures = selection ? [{ roomId: selection.parityRoom }] : db.prepare("SELECT record_id AS roomId,last_seen_at AS recordedAt FROM integrity_failures WHERE step='messages_parity' AND record_id!='' ORDER BY record_id LIMIT ?").all(LIMITS.rooms + 1);
    const rooms = failures.slice(0, limits.rooms).map(failure => {
      const result = { ...failure, status: 'unknown', complete: false, exactLegacyShapeOnly: false };
      const unknown = reason => ({ ...result, ...(selection ? { proofsVerified: false } : {}), reason });
      try {
        if (expired()) return unknown('budget_exceeded');
        if (selection) {
          const admission = admitSelected(db, failure.roomId);
          if (admission.reason) return unknown(admission.reason);
          result.admission = admission;
        }
        const size = db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?').get(failure.roomId);
        if (!size) return unknown('room_missing');
        result.head = size.sequence;
        if (selection && size.sequence !== selection.expectedHead) return unknown('head_changed');
        if (size.bytes > limits.bytes) return unknown('byte_limit');
        const cursor = db.prepare('SELECT applied_seq,parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get(failure.roomId);
        result.appliedSequence = cursor?.applied_seq ?? null;
        if (selection) result.recordedCertifiedSequence = cursor?.parity_at_seq ?? null;
        else result.certifiedSequence = cursor?.parity_at_seq ?? null;
        if (selection) result.headEventId = db.prepare('SELECT id FROM events WHERE room_id=? AND sequence=?').get(failure.roomId, size.sequence)?.id ?? null;
        if (!messagesBackfillCaughtUp(db, failure.roomId)) return unknown('not_caught_up');
        const projectionText = db.prepare('SELECT projection FROM rooms WHERE id=?').get(failure.roomId).projection;
        const projection = JSON.parse(projectionText);
        if (selection) {
          if (projection.room?.id !== failure.roomId || projection.messageAuthority || projection.messagesArchive || projection.messages?.some(message => message?._entity)) return unknown('unsupported_shape');
          const proof = db.prepare('SELECT metadata_hash FROM integrity_room_state WHERE room_id=?').get(failure.roomId);
          if (!/^[a-f0-9]{64}$/.test(proof?.metadata_hash ?? '')) return unknown('proof_missing');
          assertProjectionWrite(db, failure.roomId);
          if (servingProofDrift(db, failure.roomId, projectionText)) return unknown('proof_invalid');
        }
        if (!Array.isArray(projection.messages) || projection.messages.length > limits.rows) return unknown('row_limit');
        // Bound materialized rows and bytes before parsing or hydrating entities.
        const bounded = db.prepare('SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(coalesce(body,\'\') AS BLOB))+length(CAST(coalesce(record_json,\'\') AS BLOB))+length(CAST(coalesce(reducer_extras_json,\'\') AS BLOB)) AS nbytes FROM messages WHERE room_id=? LIMIT ?)').get(failure.roomId, limits.rows + 1);
        if (bounded.n > limits.rows) return unknown('row_limit');
        if (bounded.bytes > limits.bytes) return unknown('byte_limit');
        if (exists(db, 'projection_bodies')) {
          const bodies = db.prepare('SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(body AS BLOB)) AS nbytes FROM projection_bodies WHERE room_id=? LIMIT ?)').get(failure.roomId, limits.rows + 1);
          if (bodies.n > limits.rows || bodies.bytes > limits.bytes) return unknown('body_limit');
        }
        const eventSize = db.prepare("SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes FROM (SELECT length(CAST(body AS BLOB)) AS nbytes FROM events WHERE room_id=? LIMIT ?)").get(failure.roomId, limits.events + 1);
        if (eventSize.n > limits.events || eventSize.bytes > limits.bytes) return unknown('event_limit');
        if (expired()) return unknown('budget_exceeded');
        const hydrated = hydrateProjection(db, failure.roomId, projection, { verifyBodyHashes: true, workEntities: false });
        if (hydrated.missing.length) return unknown('body_missing');
        const state = hydrated.state, messages = new Map(state.messages.map(message => [message.id, message]));
        const rows = db.prepare(selection ? `SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? LIMIT ?` : 'SELECT * FROM messages WHERE room_id=? LIMIT ?').all(failure.roomId, limits.rows + 1);
        if (selection && rows.some(row => !messageProofMatches(row))) return unknown('proof_invalid');
        const sequences = new Map(), receipts = new Map(); let postedLastSequence = 0;
        for (const event of db.prepare("SELECT sequence,body FROM events WHERE room_id=? ORDER BY sequence LIMIT ?").all(failure.roomId, limits.events + 1)) {
          if (expired()) return unknown('budget_exceeded');
          const body = JSON.parse(event.body);
          if (body.type !== 'message.posted') continue;
          postedLastSequence = event.sequence;
          for (const id of affectedMessageIds(body)) if (!sequences.has(id)) { sequences.set(id, event.sequence); receipts.set(id, body.data?.receiptId ?? null); }
        }
        const archive = archiveMarker(db, failure.roomId), retained = new Set(archive.retainedIds);
        const archived = row => archive.throughSeq > 0 && row.seq <= archive.throughSeq && !retained.has(row.message_id);
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
        return { ...result, ...(selection ? { proofsVerified: true } : {}), complete: true, status: fields.size ? 'mismatch' : 'clean',
          missingRows, extraRows, mismatchedRows, fields: [...fields].sort(), ...(selection ? {} : { recordJsonKeys: [...keys].sort() }),
          exactLegacyShapeOnly: fields.size === 1 && fields.has('record_json') && legacyOnly };
      } catch { return unknown('comparison_unavailable'); }
    });
    return { ...(selection ? { selected: true, selection: { roomId: selection.parityRoom, expectedHead: selection.expectedHead } } : {}), rooms, truncated: failures.length > limits.rooms, limits };
  });
}
