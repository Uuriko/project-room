// Current message records across the migration boundary. The working set wins;
// only rows explicitly removed by the archive marker may supply missing records.
// Uncertified non-archived rows are never used as a fallback. Authorization stays
// with the caller; this repository neither caches viewers nor relaxes visibility.
import { messageReadIndex } from './message-read-index.mjs';
import { archiveMarker } from './messages-store.mjs';

function decode(row) {
  const record = JSON.parse(row.record_json);
  if (!record || record.id !== row.message_id || typeof record !== 'object') {
    throw new Error('Invalid archived message record');
  }
  // NULL is meaningful for deleted/redacted content, never resurrect record text.
  return { ...record, body: row.body };
}

export function messageRepository(store, roomId, state = store.room(roomId).state) {
  const live = messageReadIndex(state.messages);
  if (!state.messagesArchive) return live;
  const marker = archiveMarker(store.db, roomId);
  const archived = 'room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))';
  const params = [roomId, marker.throughSeq, marker.retainedJson];
  // Request-scoped derived reply sets avoid one history scan per inbox item.
  const replies = new Map();
  return Object.freeze({
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
