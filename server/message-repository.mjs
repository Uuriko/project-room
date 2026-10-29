import { messageQueries, decodeMessageRecord as decode } from './message-queries.mjs';
// Current message records across the migration boundary. The working set wins;
// only rows explicitly removed by the archive marker may supply missing records.
// Uncertified non-archived rows are never used as a fallback. Authorization stays
// with the caller; this repository neither caches viewers nor relaxes visibility.
import { messageReadIndex } from './message-read-index.mjs';
import { archiveMarker, archivedMessageRow } from './messages-store.mjs';
import { hydrateRecordText } from './projection-at-rest.mjs';
import { hydrateMessageEntities, isMessageEntityRef } from './message-entity-projection.mjs';

export function messageRepository(store, roomId, state = store.room(roomId).state) {
  const live = messageReadIndex(state.messages);
  const marker = state.messagesArchive ? archiveMarker(store.db, roomId) : null;
  const queries = messageQueries(store, roomId, state, marker);
  if (!marker) return Object.freeze({ ...live, ...queries,
    getMany(ids) {
      const found = new Map();
      for (const id of ids) { const record = live.get(id); if (record) found.set(id,record); }
      return found;
    }
  });
  const archived = 'room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))';
  const params = [roomId, marker.throughSeq, marker.retainedJson];
  // Request-scoped derived reply sets avoid one history scan per inbox item.
  const replies = new Map();
  return Object.freeze({
    ...queries,
    get(id) {
      const current = live.get(id);
      if (current || typeof id !== 'string') return current;
      const row = store.db.prepare(`SELECT message_id,record_json,body FROM messages WHERE ${archived} AND message_id=?`).get(...params, id);
      return row ? decode(row) : undefined;
    },
    getMany(ids) {
      const unique = [...new Set(ids.filter(id => typeof id === 'string'))];
      const found = new Map(), missing = [];
      for (const id of unique) {
        const record = live.get(id);
        if (record) found.set(id, record); else missing.push(id);
      }
      // One JSON binding per bounded batch works within Workers SQL limits.
      for (let start = 0; start < missing.length; start += 256) {
        const rows = store.db.prepare(`SELECT message_id,record_json,body FROM messages WHERE ${archived} AND message_id IN (SELECT value FROM json_each(?))`)
          .all(...params, JSON.stringify(missing.slice(start, start + 256)));
        for (const row of rows) found.set(row.message_id, decode(row));
      }
      return found;
    },
    receivedBy(memberId) {
      const rows = store.db.prepare(`SELECT message_id,record_json,body FROM messages WHERE ${archived} AND to_member_id=? ORDER BY seq`).all(...params, memberId);
      return [...rows.map(decode), ...live.receivedBy(memberId)];
    },
    hasReply(authorId, messageId) {
      if (live.hasReply(authorId, messageId)) return true;
      if (!replies.has(authorId)) {
        replies.set(authorId, new Set(store.db.prepare(`SELECT reply_to_id FROM messages WHERE ${archived} AND author_id=? AND reply_to_id IS NOT NULL`).all(...params, authorId).map(row => row.reply_to_id)));
      }
      return replies.get(authorId).has(messageId);
    }
  });
}

// Follow only this message's ancestry; do not build a whole-room thread graph.
export function messageThreadRoot(repository, id) {
  let message = repository.get(id);
  const seen = new Set();
  while (message?.replyToId) {
    if (seen.has(message.id)) throw new Error('Cyclic message ancestry');
    seen.add(message.id);
    const parent = repository.get(message.replyToId);
    if (!parent) break;
    message = parent;
  }
  return message?.id;
}

// Selected canonical lookup across inline, body-reference, entity and archive
// storage. SQLite still scans the legacy JSON carrier; only one record crosses
// into JS and unrelated bodies are never hydrated. Call inside a read transaction.
export function selectedMessageRecord(store, roomId, id, hasArchive = false) {
  const row = store.db.prepare("SELECT m.value FROM rooms r,json_each(r.projection,'$.messages') m WHERE r.id=? AND json_extract(m.value,'$.id')=? ORDER BY CAST(m.key AS INTEGER) DESC LIMIT 1").get(roomId, id);
  if (row) {
    const record = JSON.parse(row.value);
    if (isMessageEntityRef(record)) return hydrateMessageEntities(store.db, roomId, [record])[0];
    return JSON.parse(hydrateRecordText(store.db, roomId, row.value,
      messageId => store.room(roomId, { verifyBodyHashes: true }).state.messages.find(message => message.id === messageId)?.body));
  }
  if (!hasArchive) return undefined;
  const archived = archivedMessageRow(store.db, roomId, id);
  return archived ? decode(archived) : undefined;
}

// Canonical live metadata in projection order. Validate every referenced entity
// before dropping bodies; unrelated corruption must not disappear on narrow reads.
// A null result requests the existing missing-body recovery path, exceptionally.
export function liveMessageMetadata(store, roomId) {
  const rows = store.db.prepare(`WITH live AS (
    SELECT m.key,m.value,
      CASE WHEN json_type(m.value,'$._entity') IN ('integer','real') AND json_extract(m.value,'$._entity')=1 THEN 1 ELSE 0 END AS entity
    FROM rooms r,json_each(r.projection,'$.messages') m WHERE r.id=?
  ) SELECT
    CASE WHEN live.entity=1 THEN
      CASE WHEN json_valid(e.record_json) THEN json_remove(e.record_json,'$.body','$.editHistory') ELSE e.record_json END
      ELSE json_remove(live.value,'$.body','$.bodyRef','$.editHistory') END AS metadata,
    CASE WHEN live.entity=0 THEN 1 ELSE
      e.message_id IS NOT NULL AND json_valid(e.record_json) AND json_valid(e.reducer_extras_json)
      AND json_type(e.record_json,'$.id')='text'
      AND json_extract(e.record_json,'$.id') IS e.message_id
      AND ((json_type(e.record_json,'$.body')='text' AND typeof(e.body)='text')
        OR (json_type(e.record_json,'$.body')='null' AND e.body IS NULL))
      AND json_extract(e.record_json,'$.body') IS e.body
      AND json_type(e.reducer_extras_json)='object'
      AND NOT EXISTS (SELECT 1 FROM json_each(e.reducer_extras_json) WHERE key<>'editHistory')
      AND (json_type(e.reducer_extras_json,'$.editHistory') IS NULL OR json_type(e.reducer_extras_json,'$.editHistory')='array')
      AND json_type(live.value,'$.id')='text'
      AND NOT EXISTS (SELECT 1 FROM json_each(live.value) WHERE key NOT IN ('id','_entity'))
    END AS valid_entity,
    CASE WHEN live.entity=0 AND json_type(live.value,'$.bodyRef')='text' THEN
      NOT EXISTS (SELECT 1 FROM projection_bodies b WHERE b.room_id=? AND b.sha=json_extract(live.value,'$.bodyRef') AND typeof(b.body)='text')
      ELSE 0 END AS missing_body
    FROM live LEFT JOIN messages e ON live.entity=1 AND e.room_id=? AND e.message_id=json_extract(live.value,'$.id')
    ORDER BY CAST(live.key AS INTEGER)`).all(roomId, roomId, roomId);
  if (rows.some(row => row.valid_entity !== 1)) throw new Error('projection_corrupt: invalid message entity');
  if (rows.some(row => row.missing_body === 1)) return null;
  return rows.map(row => JSON.parse(hydrateRecordText(store.db, roomId, row.metadata)));
}
