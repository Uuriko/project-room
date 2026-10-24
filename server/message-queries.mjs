// Ordered, explicitly requested queries over the transitional message store.
// This module never hydrates full history into the room projection.
import { archiveMarker } from './messages-store.mjs';
import { DEFAULT_CHANNEL_ID } from '../src/events.js';
import { messageInHistory } from './history-visibility.mjs';

// S-6: per-store retained-set seq maps (see liveSeqs below). WeakMap so a
// discarded store takes its cache with it.
const seqCaches = new WeakMap();

export function decodeMessageRecord(row) {
  const record = JSON.parse(row.record_json);
  if (!record || typeof record !== 'object' || record.id !== row.message_id) throw new Error('Invalid archived message record');
  return { ...record, body: row.body };
}

export function messageQueries(store, roomId, state, marker = state.messagesArchive ? archiveMarker(store.db, roomId) : null) {
  const live = state.messages ?? [];
  const archived = 'room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))';
  const params = marker ? [roomId, marker.throughSeq, marker.retainedJson] : [];
  // The retained set's id→seq map. A message row's seq is fixed at insert (no
  // update path touches it) and the room sequence advances on every command,
  // so (room sequence, archive marker) pins the map: cache it per store and
  // let any write move the key past the stale entry. Stores that cannot key
  // it (test doubles without room()) build it fresh, as before.
  function liveSeqs(ids) {
    let cache = null, key = null;
    if (marker && typeof store.room === 'function') {
      key = `${store.room(roomId).sequence}|${marker.throughSeq}|${marker.retainedJson}`;
      cache = seqCaches.get(store);
      if (!cache) { cache = new Map(); seqCaches.set(store, cache); }
      const hit = cache.get(roomId);
      if (hit && hit.key === key) return hit.seqs;
    }
    const seqs = new Map();
    for (let start = 0; start < ids.length; start += 256) {
      for (const row of store.db.prepare('SELECT message_id,seq FROM messages WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))').all(roomId, JSON.stringify(ids.slice(start,start+256)))) seqs.set(row.message_id,row.seq);
    }
    if (cache) cache.set(roomId, { key, seqs });
    return seqs;
  }
  // Archived-leg viewer count with both visibility halves pushed into SQL:
  // the targeted-DM rule and the PRIV-2 history floor (created_at window +
  // same-instant exclusions, encoded exactly as records()' visibleSql).
  function countArchivedForViewer(viewerId, floor = null) {
    if (!marker) return 0;
    const at = floor?.at ?? null;
    const row = store.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${archived}
      AND (to_member_id IS NULL OR to_member_id='' OR author_id=? OR to_member_id=?)
      AND (? IS NULL OR created_at>=?)
      AND (? IS NULL OR created_at>? OR message_id NOT IN (SELECT value FROM json_each(?)))`)
      .get(...params, viewerId, viewerId, at, at, at, at, JSON.stringify([...(floor?.sameInstant ?? [])]));
    return Number(row?.n ?? 0);
  }
  function* records({ bodyPrefix = null, descending = false, afterId = null, visibility = null } = {}) {
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
    if (!marker) {
      const cursor = afterId === null ? null : live.findIndex(m => m.id === afterId);
      if (cursor === -1) throw new RangeError('Unknown message cursor');
      if (descending) { for (let i = cursor === null ? live.length - 1 : cursor - 1; i >= 0; i--) if (matches(live[i])) yield live[i]; }
      else { for (let i = cursor === null ? 0 : cursor + 1; i < live.length; i++) if (matches(live[i])) yield live[i]; }
      return;
    }
    const ids = live.map(m => m.id);
    const seqs = liveSeqs(ids);
    const order = (a,b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let cursor = null;
    if (afterId !== null) {
      const row = store.db.prepare(`SELECT message_id,seq FROM messages WHERE room_id=? AND message_id=?
        AND (seq<=? OR message_id IN (SELECT value FROM json_each(?)))`).get(roomId, afterId, marker.throughSeq, JSON.stringify(ids));
      if (!row) throw new RangeError('Unknown message cursor');
      cursor = {seq:row.seq,id:row.message_id};
    }
    const retained = live.filter(matches).map(message => {
      if (!seqs.has(message.id)) throw new Error('Working-set message has no posting sequence');
      return {seq:seqs.get(message.id),id:message.id,message};
    }).filter(record => cursor === null || (descending ? order(record,cursor)<0 : order(record,cursor)>0))
      .sort((a,b)=>descending ? -order(a,b) : order(a,b));
    const direction = descending ? 'DESC' : 'ASC', compare = descending ? '<' : '>';
    let sequence = cursor?.seq ?? (descending ? Number.MAX_SAFE_INTEGER : -1), id = cursor?.id ?? '', offset = 0;
    for (;;) {
      const rows = store.db.prepare(`SELECT message_id,seq,record_json,body FROM messages WHERE ${archived}
        AND (seq ${compare} ? OR (seq=? AND message_id ${compare} ?))
        ${visibleSql}
        ${bodyPrefix === null ? '' : 'AND substr(body,1,length(?))=?'} ORDER BY seq ${direction},message_id ${direction} LIMIT 128`)
        .all(...params, sequence, sequence, id, ...visibleParams, ...(bodyPrefix === null ? [] : [bodyPrefix,bodyPrefix]));
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
          AND (seq>? OR (seq=? AND message_id>?)) ORDER BY seq,message_id LIMIT 256`).all(...params,sequence,sequence,id);
        if(!rows.length)break;
        for(const row of rows)if(visible({id:row.message_id,authorId:row.author_id,toMemberId:row.to_member_id,createdAt:row.created_at,deletedAt:row.deleted_at}))count++;
        const last=rows.at(-1);sequence=last.seq;id=last.message_id;
      }
      return count;
    },
    // Viewer-visible totals without decoding archived bodies: the live leg
    // applies the predicate snapshot() hands countMetadata; the archived leg
    // is the single SQL COUNT above. The boundary suite pins agreement with
    // countMetadata over the equivalent predicate (DM mixes, floor shapes).
    countForViewer(viewerId, floor = null) {
      return live.filter(m => messageInHistory(m, floor)
        && (!m.toMemberId || m.authorId === viewerId || m.toMemberId === viewerId)).length
        + countArchivedForViewer(viewerId, floor);
    },
    countArchivedForViewer,
    recent(limit, visible = () => true) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new RangeError('Recent-message limit must be 0 to 1000');
      const out=[];if(!limit)return out;
      for(const m of records({descending:true})) if(visible(m)){out.push(m);if(out.length===limit)break;}
      return out.reverse();
    },
    firstPostedAtByAuthor() {
      const result=new Map();
      const add=(author,at)=>{const time=Date.parse(at);if(author && Number.isFinite(time) && (!result.has(author)||time<result.get(author)))result.set(author,time);};
      if(marker) {
        let sequence=-1,id='';
        for (;;) {
          const rows=store.db.prepare(`SELECT seq,message_id,author_id,created_at FROM messages WHERE ${archived}
            AND (seq>? OR (seq=? AND message_id>?)) ORDER BY seq,message_id LIMIT 256`).all(...params,sequence,sequence,id);
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
