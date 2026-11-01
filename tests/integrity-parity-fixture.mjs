// Fixture builder for tests/integrity-parity-bounding.test.js — the synthetic
// large-history room specified by the #5571 part-2 design
// (~/workspace/wave-2026-11-01-everything/pr3/PART2-DESIGN.md §6).
//
// The room is generated directly at the SQL level, in the exact shapes the
// reducer and the messages backfill write, so parity certification sees a
// room indistinguishable from a command-built one:
//
//   - events rows carrying full message.posted event JSON (the event's own
//     id, idempotency key, actor, timestamp and data{messageId, body});
//   - rooms.projection holding the reducer's message records inline
//     ({id, authorId, body, channelId, workItemId, replyToId, toMemberId,
//     createdAt}), appended in sequence order to the seeded projection;
//   - messages rows whose record_json is that same record serialised,
//     reducer_extras_json "{}", and entity_hash computed with the codebase's
//     own messageProofHash (server/write-integrity.mjs) over the row fields;
//   - messages_backfill_cursor caught up to the room head
//     (applied_seq = applied_event_id at head), parity_at_seq NULL.
//
// Message ids are zero-padded (fx-000000, fx-000001, ...) so the messages
// table's key order is the numeric order. Bodies are deterministic:
// `fixture message ${i} ` padded with a repeated sentence to bodyBytes.
//
// Calibration (measured 2026-11-01 on the fleet VM under load,
// pre-change main 513d3ee8): BIG_COUNT = 100000 messages x 1024-byte
// bodies gives a 118,600,716-byte projection and single-pass
// checkMessagesParity times of ~20 s cold / ~19 s warm / ~13 s on the
// third consecutive run — measurably over the 5 s job budget with ~2x
// margin over the design's deadline + 1500 ms assertion bound even when
// fully warm. (At 256-byte bodies the warm time sagged to ~6.5 s, too
// close to the bound; the per-row byte work at 1024 bytes is what makes
// the cost warmth-insensitive.) Smaller rooms do not clear the bound at
// the Node store seam (20k messages certifies in ~3.5 s warm): the
// production stall's structuredClone costs exist only in the Durable
// Object path, so this fixture reproduces the contract violation
// (certification >> budget), not the production room's byte size. See
// the p2tests lane STATE.md for the full calibration table.
import { createHash } from 'node:crypto';
import { messageProofHash } from '../server/write-integrity.mjs';

export const BIG_COUNT = 100000;
export const BODY_BYTES = 1024;
const BASE_MS = Date.parse('2026-10-01T00:00:00.000Z');

export function fixtureBody(i, bodyBytes = BODY_BYTES) {
  const head = `fixture message ${i} `;
  if (bodyBytes <= head.length) return head.slice(0, bodyBytes);
  return head + 'lorem ipsum dolor sit amet '.repeat(Math.ceil((bodyBytes - head.length) / 27)).slice(0, bodyBytes - head.length);
}

export function fixtureRecord(i, bodyBytes = BODY_BYTES) {
  return {
    id: `fx-${String(i).padStart(6, '0')}`,
    authorId: 'owner',
    body: fixtureBody(i, bodyBytes),
    channelId: 'general',
    workItemId: null,
    replyToId: null,
    toMemberId: null,
    createdAt: new Date(BASE_MS + (i + 1) * 2001).toISOString()
  };
}

function fixtureRow(i, seq, bodyBytes) {
  const record = fixtureRecord(i, bodyBytes);
  const row = {
    message_id: record.id, seq, channel_id: 'general', thread_root_id: null, reply_to_id: null,
    to_member_id: null, work_item_id: null, author_id: 'owner', body: record.body,
    created_at: record.createdAt, edited_at: null, deleted_at: null, reactions_json: null,
    pinned: 0, record_json: JSON.stringify(record), reducer_extras_json: '{}'
  };
  return { record, row, entityHash: messageProofHash(row) };
}

// Appends `count` fixture messages (indices startIndex..startIndex+count-1)
// to a room that already exists in the store (seeded by initialRoom) and
// whose current head is 2 + startIndex (two seed events precede them).
// One transaction; returns the new head sequence.
export function appendFixtureMessages(store, { roomId, startIndex = 0, count, bodyBytes = BODY_BYTES }) {
  const db = store.db;
  const head = db.prepare('SELECT sequence, projection FROM rooms WHERE id=?').get(roomId);
  if (!head) throw new Error(`fixture room ${roomId} does not exist`);
  if (head.sequence !== 2 + startIndex) throw new Error(`fixture room ${roomId} head ${head.sequence} != expected ${2 + startIndex}`);
  const projection = JSON.parse(head.projection);
  const records = Array.isArray(projection.messages) ? projection.messages : [];
  const insertEvent = db.prepare('INSERT INTO events (room_id, sequence, id, body) VALUES (?,?,?,?)');
  const insertRow = db.prepare(`INSERT INTO messages (
    room_id, message_id, seq, channel_id, thread_root_id, reply_to_id, to_member_id, work_item_id,
    author_id, body, created_at, edited_at, deleted_at, reactions_json, pinned, record_json, reducer_extras_json, entity_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let lastEventId = null;
  db.exec('BEGIN');
  try {
    for (let i = startIndex; i < startIndex + count; i++) {
      const seq = head.sequence + 1 + (i - startIndex);
      const record = fixtureRecord(i, bodyBytes);
      // Event ids are globally unique in a real store (one events table for
      // all rooms), so derive them from the (room, index) pair.
      const digest = createHash('sha256').update(`fx-event-${roomId}-${i}`).digest('hex');
      const eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4000-8000-${digest.slice(20, 32)}`;
      lastEventId = eventId;
      insertEvent.run(roomId, seq, eventId, JSON.stringify({
        id: eventId,
        idempotencyKey: createHash('sha256').update(`fx-${roomId}-${i}`).digest('hex'),
        roomId, type: 'message.posted', actorId: 'owner', at: record.createdAt, causationId: null,
        data: { messageId: record.id, body: record.body }
      }));
      records.push(record);
      const { row, entityHash } = fixtureRow(i, seq, bodyBytes);
      insertRow.run(roomId, row.message_id, row.seq, row.channel_id, row.thread_root_id, row.reply_to_id,
        row.to_member_id, row.work_item_id, row.author_id, row.body, row.created_at, row.edited_at,
        row.deleted_at, row.reactions_json, row.pinned, row.record_json, row.reducer_extras_json, entityHash);
    }
    const newHead = head.sequence + count;
    db.prepare('UPDATE rooms SET projection=?, sequence=? WHERE id=?')
      .run(JSON.stringify({ ...projection, messages: records }), newHead, roomId);
    db.prepare(`INSERT INTO messages_backfill_cursor (room_id, applied_seq, applied_event_id, state_seq, replay_event_id, parity_at_seq, sweep_after)
      VALUES (?, ?, ?, ?, ?, NULL, '')
      ON CONFLICT(room_id) DO UPDATE SET applied_seq=excluded.applied_seq, applied_event_id=excluded.applied_event_id,
        state_seq=excluded.state_seq, replay_event_id=excluded.replay_event_id, parity_at_seq=NULL`)
      .run(roomId, newHead, lastEventId, newHead, lastEventId);
    db.exec('COMMIT');
    return newHead;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function generateFixtureRoom(store, { roomId, count, bodyBytes = BODY_BYTES }) {
  return appendFixtureMessages(store, { roomId, startIndex: 0, count, bodyBytes });
}
