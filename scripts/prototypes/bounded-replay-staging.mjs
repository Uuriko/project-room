// Executable format experiment. Not imported by the service or a migration.
// Staging checksums detect torn/corrupt staging; they are NOT serving proofs.
import { createHash } from 'node:crypto';
import { applyEvent } from '../../src/events.js';

export const limits = Object.freeze({ metadata: 65536, message: 131072, event: 32768 });
export const schema = `
CREATE TABLE message_replay_formats (
 room_id TEXT PRIMARY KEY REFERENCES rooms(id),
 version INTEGER NOT NULL CHECK(version=1),
 metadata_json TEXT NOT NULL,
 metadata_sha TEXT NOT NULL,
 event_sha TEXT NOT NULL
);
CREATE TABLE message_replay_units (
 room_id TEXT NOT NULL REFERENCES rooms(id),
 message_id TEXT NOT NULL,
 json TEXT NOT NULL,
 sha TEXT NOT NULL,
 PRIMARY KEY(room_id,message_id)
);`;
export const digest = json => createHash('sha256').update(json).digest('hex');
const bytes = json => Buffer.byteLength(json, 'utf8');
const pending = reason => ({ status: 'pending', reason, publication: 'pending', certified: false });

function readBounded(db, table, key, id, column, cap, census) {
  // table/key/column are internal constants. Payload never crosses the SQL/JS
  // boundary until a single indexed row's UTF-8 length has been admitted.
  const size = db.prepare(`SELECT CASE WHEN typeof(${column})='text' THEN length(CAST(${column} AS BLOB)) END AS n FROM ${table} WHERE ${key}`).get(...id);
  census.sizeRows += size ? 1 : 0;
  if (!size) throw new Error('missing replay source');
  if (!Number.isSafeInteger(size.n) || size.n > cap) throw new Error('unit-byte-limit');
  const fields = table === 'events' ? 'id,body' : table === 'message_replay_formats'
    ? "CASE WHEN typeof(version)='integer' AND version=1 THEN version END AS version,metadata_json,metadata_sha,event_sha" : 'json,sha';
  const fixedSizes = table === 'events' ? "typeof(id)='text' AND length(CAST(id AS BLOB))<=200"
    : table === 'message_replay_formats' ? "typeof(metadata_sha)='text' AND typeof(event_sha)='text' AND length(CAST(metadata_sha AS BLOB))=64 AND length(CAST(event_sha AS BLOB))=64"
      : "typeof(sha)='text' AND length(CAST(sha AS BLOB))=64";
  const row = db.prepare(`SELECT ${fields} FROM ${table} WHERE ${key} AND ${fixedSizes}`).get(...id);
  if (!row) throw new Error('replay control field size differs');
  census.payloadRows += 1;
  census.payloadBytes += size.n;
  return row;
}

// One transition, in the existing writer transaction, using its existing
// durable cursor. Exactly one event family is qualified: top-level edits.
// No import/bootstrap API: tests seed an independently known synthetic prefix.
export function step(db, roomId, census = { sizeRows: 0, payloadRows: 0, payloadBytes: 0 }) {
  if (!db.isTransaction) throw new Error('prototype requires writer transaction');
  if (typeof roomId !== 'string' || bytes(roomId) > 200) throw new Error('invalid room id');
  // INTEGER affinity is not a storage-type guarantee. A corrupt 2MiB TEXT or
  // BLOB scalar must become NULL inside SQLite, before any JS materialization.
  const cursor = db.prepare(`SELECT
    CASE WHEN typeof(state_seq)='integer' AND state_seq BETWEEN 1 AND 9007199254740991 THEN state_seq END AS state_seq,
    CASE WHEN typeof(replay_event_id)='text' AND length(CAST(replay_event_id AS BLOB))<=200 THEN replay_event_id END AS replay_event_id
    FROM messages_backfill_cursor WHERE room_id=?`).get(roomId);
  if (!cursor || !Number.isSafeInteger(cursor.state_seq) || cursor.state_seq < 1) return pending('qualified-prefix-required');
  if (cursor.replay_event_id === null) throw new Error('invalid replay anchor id');
  const head = db.prepare(`SELECT CASE WHEN typeof(sequence)='integer'
    AND sequence BETWEEN 0 AND 9007199254740991 THEN sequence END AS sequence FROM rooms WHERE id=?`).get(roomId)?.sequence;
  if (!Number.isSafeInteger(head) || head < cursor.state_seq) throw new Error('invalid replay head');
  const header = readBounded(db, 'message_replay_formats', 'room_id=?', [roomId], 'metadata_json', limits.metadata, census);
  if (header.version !== 1 || digest(header.metadata_json) !== header.metadata_sha) throw new Error('corrupt replay metadata');
  const anchor = readBounded(db, 'events', 'room_id=? AND sequence=?', [roomId, cursor.state_seq], 'body', limits.event, census);
  if (anchor.id !== cursor.replay_event_id || digest(anchor.body) !== header.event_sha) throw new Error('replay anchor changed');
  const nextSize = db.prepare(`SELECT CASE WHEN typeof(sequence)='integer'
    AND sequence BETWEEN 1 AND 9007199254740991 THEN sequence END AS sequence,
    CASE WHEN typeof(body)='text' THEN length(CAST(body AS BLOB)) END AS n
    FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1`).get(roomId, cursor.state_seq);
  census.sizeRows += nextSize ? 1 : 0;
  if (!nextSize) return pending(head === cursor.state_seq ? 'publication-not-implemented' : 'event-gap');
  if (nextSize.sequence !== cursor.state_seq + 1) return pending('event-gap');
  if (nextSize.sequence > head) throw new Error('event beyond replay head');
  if (!Number.isSafeInteger(nextSize.n) || nextSize.n > limits.event) return pending('event-byte-limit');
  const source = db.prepare("SELECT id,body FROM events WHERE room_id=? AND sequence=? AND typeof(id)='text' AND length(CAST(id AS BLOB))<=200").get(roomId, nextSize.sequence);
  if (!source) throw new Error('replay control field size differs');
  census.payloadRows += 1; census.payloadBytes += nextSize.n;
  const incoming = JSON.parse(source.body);
  if (incoming.id !== source.id || incoming.roomId !== roomId) throw new Error('invalid event anchor');
  if (incoming.type !== 'message.edited') return pending('unsupported-event-family');
  const id = incoming.data?.messageId;
  if (typeof id !== 'string' || bytes(id) > 200 || id.endsWith(':channel')) return pending('unsupported-message-context');
  const metadata = JSON.parse(header.metadata_json);
  if (Object.hasOwn(metadata, 'messages') || metadata.messagesArchive
    || metadata.room?.publicPage?.enabled || metadata.room?.publicReceipts?.enabled) return pending('unsupported-room-context');
  const target = readBounded(db, 'message_replay_units', 'room_id=? AND message_id=?', [roomId, id], 'json', limits.message, census);
  if (digest(target.json) !== target.sha) throw new Error('corrupt replay message');
  const message = JSON.parse(target.json);
  if (message.id !== id) throw new Error('replay message key differs');
  if (message.replyToId) return pending('unsupported-message-context');
  // Reuse the real reducer, with bounded complete metadata and the one entity
  // this qualified transition can read/write. No new message semantics here.
  const next = applyEvent({ ...metadata, messages: [message], eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} }, incoming);
  const json = JSON.stringify(next.messages[0]);
  if (bytes(json) > limits.message) return pending('output-byte-limit');
  // Even an edit can run common reducer metadata upgrades (default channels,
  // work controls). Preserve those changes; do not assume the handler alone
  // defines its write set.
  const { messages, eventLog, seenEvents, seenIdempotencyKeys, ...nextMetadata } = next;
  const metadataJson = JSON.stringify(nextMetadata);
  if (bytes(metadataJson) > limits.metadata) return pending('metadata-output-byte-limit');
  db.prepare('UPDATE message_replay_units SET json=?,sha=? WHERE room_id=? AND message_id=?').run(json, digest(json), roomId, id);
  db.prepare('UPDATE message_replay_formats SET metadata_json=?,metadata_sha=?,event_sha=? WHERE room_id=?')
    .run(metadataJson, digest(metadataJson), digest(source.body), roomId);
  db.prepare('UPDATE messages_backfill_cursor SET state_seq=?,replay_event_id=? WHERE room_id=?').run(nextSize.sequence, source.id, roomId);
  return { ...pending('publication-not-implemented'), advanced: true, replaySeq: nextSize.sequence };
}
