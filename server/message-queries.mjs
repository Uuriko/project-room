// Ordered, explicitly requested queries over the transitional message store.
// This module never hydrates full history into the room projection.
import { archiveMarker, affectedMessageIds } from './messages-store.mjs';
import { DEFAULT_CHANNEL_ID } from '../src/events.js';
import { messageInHistory } from './history-visibility.mjs';

export function decodeMessageRecord(row) {
  const record = JSON.parse(row.record_json);
  if (!record || typeof record !== 'object' || record.id !== row.message_id) throw new Error('Invalid archived message record');
  return { ...record, body: row.body };
}

// Indexed posting provenance, with a bounded-ID fallback during backfill.
// A posted reply can also create a channel copy at the same sequence.
export function messageSequences(db, roomId, ids) {
  const seqs = new Map();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 256) {
    const batch = unique.slice(start, start + 256);
    for (const row of db.prepare('SELECT message_id,seq FROM messages WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))').all(roomId, JSON.stringify(batch))) seqs.set(row.message_id,row.seq);
    const missing = new Set(batch.filter(id => !seqs.has(id)));
    if (!missing.size) continue;
    const candidates = [...new Set([...missing].flatMap(id => id.endsWith(':channel') ? [id,id.slice(0,-8)] : [id]))];
    const postedId = "CASE WHEN json_type(body,'$.data.messageId')='text' AND json_extract(body,'$.data.messageId')<>'' THEN json_extract(body,'$.data.messageId') ELSE json_extract(body,'$.id') END";
    const rows = db.prepare(`SELECT sequence,body FROM events WHERE room_id=? AND json_extract(body,'$.type')='message.posted'
      AND (${postedId}) IN (SELECT value FROM json_each(?)) ORDER BY sequence`).all(roomId,JSON.stringify(candidates));
    for (const row of rows) for (const id of affectedMessageIds(JSON.parse(row.body))) {
      if (missing.has(id) && !seqs.has(id)) seqs.set(id,row.sequence);
    }
  }
  return seqs;
}

export function messageQueries(store, roomId, state, marker = state.messagesArchive ? archiveMarker(store.db, roomId) : null) {
  const live = state.messages ?? [];
  const archived = 'room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))';
  const params = marker ? [roomId, marker.throughSeq, marker.retainedJson] : [];
  function* records({ bodyPrefix = null, descending = false, afterId = null, beforeSequence = null, beforeId = null, visibility = null } = {}) {
    if (beforeId !== null && (beforeSequence === null || typeof beforeId !== 'string' || !beforeId || beforeId.length > 256)) throw new TypeError('Message tie-break requires a sequence cursor');
    if (beforeSequence !== null && (!descending || afterId !== null || !Number.isSafeInteger(beforeSequence) || beforeSequence < 0)) throw new TypeError('Sequence cursor requires descending order and no ID cursor');
    if (afterId !== null && typeof afterId !== 'string') throw new TypeError('Message cursor must be an ID');
    if (bodyPrefix !== null && typeof bodyPrefix !== 'string') throw new TypeError('Message prefix must be text');
    const matches = m => (bodyPrefix === null || typeof m.body === 'string' && m.body.startsWith(bodyPrefix))
      && (!visibility || ((!m.toMemberId || m.authorId === visibility.viewerId || m.toMemberId === visibility.viewerId)
        && (visibility.channelId == null || !m.toMemberId && (m.channelId || DEFAULT_CHANNEL_ID) === visibility.channelId)
        && (!visibility.floor || messageInHistory(m, visibility.floor))));
    // Filter archived visibility metadata in SQLite before fetching bodies.
    // The caller authenticates the viewer and supplies the current history floor.
    const visibleSql = visibility ? `
      AND (to_member_id IS NULL OR to_member_id='' OR author_id=? OR to_member_id=?)
      AND (? IS NULL OR (COALESCE(NULLIF(channel_id,''),?)=? AND (to_member_id IS NULL OR to_member_id='')))
      AND (? IS NULL OR created_at>=?)
      AND (? IS NULL OR created_at>? OR message_id NOT IN (SELECT value FROM json_each(?)))` : '';
    const visibleParams = visibility ? [visibility.viewerId, visibility.viewerId,
      visibility.channelId ?? null, DEFAULT_CHANNEL_ID, visibility.channelId ?? null,
      visibility.floor?.at ?? null, visibility.floor?.at ?? null,
      visibility.floor?.at ?? null, visibility.floor?.at ?? null,
      JSON.stringify([...(visibility.floor?.sameInstant ?? [])])] : [];
    if (!marker && beforeSequence === null) {
      const cursor = afterId === null ? null : live.findIndex(m => m.id === afterId);
      if (cursor === -1) throw new RangeError('Unknown message cursor');
      if (descending) { for (let i = cursor === null ? live.length - 1 : cursor - 1; i >= 0; i--) if (matches(live[i])) yield live[i]; }
      else { for (let i = cursor === null ? 0 : cursor + 1; i < live.length; i++) if (matches(live[i])) yield live[i]; }
      return;
    }
    const ids = live.map(m => m.id);
    const seqs = messageSequences(store.db, roomId, ids);
    const order = (a,b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let cursor = beforeSequence === null ? null : { seq: beforeSequence, id: beforeId ?? '' };
    if (afterId !== null) {
      const row = seqs.has(afterId) ? {message_id:afterId,seq:seqs.get(afterId)} : store.db.prepare(`SELECT message_id,seq FROM messages WHERE room_id=? AND message_id=?
        AND (seq<=? OR message_id IN (SELECT value FROM json_each(?)))`).get(roomId, afterId, marker.throughSeq, JSON.stringify(ids));
      if (!row) throw new RangeError('Unknown message cursor');
      cursor = {seq:row.seq,id:row.message_id};
    }
    const retained = live.filter(matches).map(message => {
      if (!seqs.has(message.id)) throw new Error('Working-set message has no posting sequence');
      return {seq:seqs.get(message.id),id:message.id,message};
    }).filter(record => cursor === null || (descending ? order(record,cursor)<0 : order(record,cursor)>0))
      .sort((a,b)=>descending ? -order(a,b) : order(a,b));
    if (!marker) { for (const record of retained) yield record.message; return; }
    const direction = descending ? 'DESC' : 'ASC', compare = descending ? '<' : '>';
    // The explicit inclusive bound lets SQLite seek the cursor in room_seq.
    // The OR tie-break alone otherwise rescans the archive prefix each page.
    const cursorBound = descending ? '<=' : '>=';
    let sequence = cursor?.seq ?? (descending ? Number.MAX_SAFE_INTEGER : -1), id = cursor?.id ?? '', offset = 0;
    for (;;) {
      // Descending pages have two upper bounds. Bind their intersection to the
      // archive range so SQLite cannot keep choosing the original archive end.
      const pageParams = descending ? [roomId, Math.min(marker.throughSeq, sequence), marker.retainedJson] : params;
      const rows = store.db.prepare(`SELECT message_id,seq,record_json,body FROM messages WHERE ${archived}
        AND seq ${cursorBound} ? AND (seq ${compare} ? OR (seq=? AND message_id ${compare} ?))
        ${visibleSql}
        ${bodyPrefix === null ? '' : 'AND substr(body,1,length(?))=?'} ORDER BY seq ${direction},message_id ${direction} LIMIT 128`)
        .all(...pageParams, sequence, sequence, sequence, id, ...visibleParams, ...(bodyPrefix === null ? [] : [bodyPrefix,bodyPrefix]));
      if (!rows.length) break;
      for (const row of rows) {
        const key = {seq:row.seq,id:row.message_id};
        while (offset < retained.length && (descending ? order(retained[offset],key)>=0 : order(retained[offset],key)<=0)) yield retained[offset++].message;
        yield decodeMessageRecord(row);
      }
      const last=rows.at(-1);sequence=last.seq;id=last.message_id;
    }
    while (offset < retained.length) yield retained[offset++].message;
  }
  return {
    records,
    // Count using only visibility metadata; never decode historical bodies.
    countMetadata(visible = () => true) {
      let count = live.filter(visible).length;
      if (!marker) return count;
      let sequence=-1,id='';
      for (;;) {
        const rows=store.db.prepare(`SELECT seq,message_id,author_id,to_member_id,created_at,deleted_at FROM messages WHERE ${archived}
          AND seq>=? AND (seq>? OR (seq=? AND message_id>?)) ORDER BY seq,message_id LIMIT 256`).all(...params,sequence,sequence,sequence,id);
        if(!rows.length)break;
        for(const row of rows)if(visible({id:row.message_id,authorId:row.author_id,toMemberId:row.to_member_id,createdAt:row.created_at,deletedAt:row.deleted_at}))count++;
        const last=rows.at(-1);sequence=last.seq;id=last.message_id;
      }
      return count;
    },
    recent(limit, visible = () => true) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new RangeError('Recent-message limit must be 0 to 1000');
      const out=[];if(!limit)return out;
      for(const m of records({descending:true})) if(visible(m)){out.push(m);if(out.length===limit)break;}
      return out.reverse();
    },
    // The room read's window count (store.snapshot): same answer as
    // countMetadata with messageInHistory(floor) plus the DM rule, but the
    // archive is counted by one SQLite aggregate instead of 256-row pages
    // decoded in JS. Every default room read pays this; it grew with history.
    countViewerVisible(viewerId, floor = null) {
      const visible = message => messageInHistory(message, floor)
        && (!message.toMemberId || message.authorId === viewerId || message.toMemberId === viewerId);
      const count = live.filter(visible).length;
      if (!marker) return count;
      const floorSql = floor ? ` AND created_at IS NOT NULL AND (created_at > ? OR (created_at = ? AND message_id NOT IN (SELECT value FROM json_each(?))))` : '';
      const floorParams = floor ? [floor.at, floor.at, JSON.stringify([...(floor.sameInstant ?? [])])] : [];
      const row = store.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${archived}
        AND (to_member_id IS NULL OR to_member_id = '' OR author_id = ? OR to_member_id = ?)${floorSql}`)
        .get(...params, viewerId, viewerId, ...floorParams);
      return count + Number(row?.n ?? 0);
    },
    firstPostedAtByAuthor() {
      const result=new Map();
      const add=(author,at)=>{const time=Date.parse(at);if(author && Number.isFinite(time) && (!result.has(author)||time<result.get(author)))result.set(author,time);};
      if(marker) {
        let sequence=-1,id='';
        for (;;) {
          const rows=store.db.prepare(`SELECT seq,message_id,author_id,created_at FROM messages WHERE ${archived}
            AND seq>=? AND (seq>? OR (seq=? AND message_id>?)) ORDER BY seq,message_id LIMIT 256`).all(...params,sequence,sequence,sequence,id);
          if(!rows.length)break;
          for(const row of rows)add(row.author_id,row.created_at);
          const last=rows.at(-1);sequence=last.seq;id=last.message_id;
        }
      }
      for(const m of live)add(m.authorId,m.createdAt);
      return result;
    }
  };
}
