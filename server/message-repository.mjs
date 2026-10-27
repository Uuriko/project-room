import { messageQueries, decodeMessageRecord as decode } from './message-queries.mjs';
// Current message records across the migration boundary. The working set wins;
// only rows explicitly removed by the archive marker may supply missing records.
// Uncertified non-archived rows are never used as a fallback. Authorization stays
// with the caller; this repository neither caches viewers nor relaxes visibility.
import { messageReadIndex } from './message-read-index.mjs';
import { archiveMarker } from './messages-store.mjs';

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
